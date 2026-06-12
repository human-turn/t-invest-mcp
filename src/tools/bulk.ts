import { unzipSync, gunzipSync } from "fflate";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../client.js";
import { ok, fail, sleep, notifyProgress, type ProgressCtx } from "../helpers.js";
import { writeRaw } from "../output.js";
import { getInstrumentRef } from "../instruments-cache.js";

const ARCHIVE_HOSTS = [
  "https://invest-public-api.tbank.ru",
  "https://invest-public-api.tinkoff.ru", // legacy host — same service, reachable from more networks
];
const CANDLE_CSV_HEADER = "instrumentUid;timeUtc;open;close;high;low;volume";
const THROTTLE_MS = 2_100; // archive endpoints limit: 30 files/min per IP
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let archiveHost: string | undefined; // host pinned after the first meaningful answer (2xx/404)

/** Diagnostics for get_server_info */
export function getArchiveHost(): string | undefined {
  return archiveHost;
}

/**
 * GET against archive hosts with network-level fallback.
 * The host is pinned only on a meaningful answer (2xx/404) — never on an error status.
 */
async function archiveFetch(pathAndQuery: string): Promise<{ res: Response; url: string }> {
  const hosts = archiveHost ? [archiveHost, ...ARCHIVE_HOSTS.filter((h) => h !== archiveHost)] : ARCHIVE_HOSTS;
  const failures: string[] = [];

  for (const host of hosts) {
    const url = `${host}${pathAndQuery}`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${config.token}` } });
      if (res.ok || res.status === 404) archiveHost = host;
      return { res, url };
    } catch (e) {
      const cause = (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
      failures.push(`GET ${url} — ${cause}`);
    }
  }
  throw new Error(`archive hosts unreachable: ${failures.join("; ")}`);
}

/** Throws a uniform error for unexpected archive statuses */
function archiveStatusError(what: string, res: Response, url: string): Error {
  return new Error(
    `${what}: HTTP ${res.status} (${url}) — the endpoint did not recognize the request; make sure instrumentId is an instrument UID and the year/date is within the available range (see get_history_archive_years)`,
  );
}

async function fetchYearZip(uid: string, year: number): Promise<Uint8Array | null> {
  for (let attempt = 0; ; attempt++) {
    const { res, url } = await archiveFetch(`/history-data?instrumentId=${encodeURIComponent(uid)}&year=${year}`);
    if (res.status === 404) return null; // no archive for this year
    if (res.status === 429 && attempt < 2) {
      await sleep(60_000);
      continue;
    }
    if (!res.ok) throw archiveStatusError(`history-data ${year}`, res, url);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** Unzip an archive and append day-file contents (sorted by name) to parts; returns row count */
function appendZipCsv(zip: Uint8Array, parts: string[]): number {
  let rows = 0;
  const files = unzipSync(zip);
  for (const name of Object.keys(files).sort()) {
    const text = new TextDecoder().decode(files[name]).trim();
    if (!text) continue;
    parts.push(text);
    rows += text.split("\n").length;
  }
  return rows;
}

/** Archive body by magic bytes: ZIP ('PK'), gzip (1f 8b) or plain CSV → parts; returns row count */
function appendArchiveCsv(bytes: Uint8Array, parts: string[]): number {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) return appendZipCsv(bytes, parts);
  const raw = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const text = new TextDecoder().decode(raw).trim();
  if (!text) return 0;
  parts.push(text);
  return text.split("\n").length;
}

interface ArchiveIndex {
  instruments: Record<
    string,
    { ticker: string; classCode: string; name: string; archives: Array<{ year: number; sizeTxt: string }> }
  >;
}

const indexCache = new Map<string, { data: ArchiveIndex; at: number }>();

async function getTypeIndex(instrumentType: string): Promise<ArchiveIndex> {
  const hit = indexCache.get(instrumentType);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.data;
  const { res, url } = await archiveFetch(`/candles-instruments-index/instrument-type/${instrumentType}`);
  if (!res.ok) throw new Error(`archive index: HTTP ${res.status} (${url})`);
  const data = (await res.json()) as ArchiveIndex;
  indexCache.set(instrumentType, { data, at: Date.now() });
  return data;
}

function requireUid(instrumentId: string): Error | null {
  if (UUID_RE.test(instrumentId)) return null;
  return new Error(
    `"${instrumentId}" is not an instrument UID — the archive endpoints accept only UIDs (uuid); resolve the ticker via find_instrument first`,
  );
}

export function registerBulkTools(server: McpServer): void {
  server.registerTool(
    "download_history_archive",
    {
      title: "Download Minute-Candle History Archive",
      description:
        "Bulk-download MINUTE candles for whole years via the REST archive endpoint (1 HTTP request = 1 year) and merge them into a single CSV file in the output root. Far cheaper than get_candles for long minute history. Columns: instrumentUid;timeUtc;open;close;high;low;volume. Archives are rebuilt nightly (no current day). Years with no data are skipped and listed in the summary. Takes the instrument UID only. Check available years first with get_history_archive_years.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID (uuid) from find_instrument; FIGI/ticker are not accepted"),
        yearFrom: z.number().int().min(2017).describe("First year to download"),
        yearTo: z.number().int().min(2017).optional().describe("Last year (default: current year)"),
        outputPath: z
          .string()
          .optional()
          .describe("Target CSV path relative to the output root (default: history_1min_<uid>_<years>.csv)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ instrumentId, yearFrom, yearTo, outputPath }, extra) => {
      try {
        const badId = requireUid(instrumentId);
        if (badId) return fail(badId);
        const lastYear = yearTo ?? new Date().getFullYear();
        if (lastYear < yearFrom) return fail(new Error("yearTo must be >= yearFrom"));
        const years: number[] = [];
        for (let y = yearFrom; y <= lastYear; y++) years.push(y);

        const parts: string[] = [CANDLE_CSV_HEADER];
        const skippedYears: number[] = [];
        let records = 0;

        for (let i = 0; i < years.length; i++) {
          const zip = await fetchYearZip(instrumentId, years[i]);
          if (zip) records += appendZipCsv(zip, parts);
          else skippedYears.push(years[i]);
          await notifyProgress(
            extra as unknown as ProgressCtx,
            i + 1,
            years.length,
            `archive ${years[i]}: ${records} candles so far`,
          );
          if (i < years.length - 1) await sleep(THROTTLE_MS);
        }

        if (records === 0) {
          return fail(
            new Error(
              `no archives found for ${instrumentId} in ${yearFrom}-${lastYear} — check available years via get_history_archive_years`,
            ),
          );
        }

        const rel = outputPath ?? `history_1min_${instrumentId}_${yearFrom}-${lastYear}.csv`;
        const { savedTo, bytes } = await writeRaw(rel, parts.join("\n") + "\n");
        return ok({
          savedTo,
          format: "csv",
          records,
          bytes,
          years: years.filter((y) => !skippedYears.includes(y)), // only the years actually downloaded
          skippedYears,
          header: CANDLE_CSV_HEADER,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_history_archive_years",
    {
      title: "List Available History Archive Years",
      description:
        "Which yearly minute-candle archives exist for an instrument (year + size). Use before download_history_archive to avoid guessing the range.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID (uuid) from find_instrument"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ instrumentId }) => {
      try {
        const badId = requireUid(instrumentId);
        if (badId) return fail(badId);
        const ref = await getInstrumentRef(instrumentId);
        if (!ref) return fail(new Error("unknown instrument UID — check it via find_instrument/get_instrument"));
        const index = await getTypeIndex(ref.instrumentType);
        const entry = index.instruments[instrumentId];
        if (!entry) {
          return ok({ instrumentUid: instrumentId, ticker: ref.ticker, available: false, years: [] });
        }
        return ok({
          instrumentUid: instrumentId,
          ticker: entry.ticker,
          name: entry.name,
          available: true,
          years: entry.archives.map((a) => ({ year: a.year, size: a.sizeTxt })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "download_trades_archive",
    {
      title: "Download Anonymized Trades Archive",
      description:
        "Download the anonymized trades archive for one trading day (history-md service) into a CSV file in the output root. Comma-separated, the file carries its own header: TRADE_TS,TICKER_CC,DIRECTION,PRICE,QUANTITY,TRADE_SOURCE,INSTRUMENT_UID. 404 means no archive for that date (weekend/holiday or not yet built — archives are rebuilt nightly).",
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID (uuid) from find_instrument"),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
          .describe("Trading day, YYYY-MM-DD"),
        outputPath: z
          .string()
          .optional()
          .describe("Target CSV path relative to the output root (default: trades_<uid>_<date>.csv)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ instrumentId, date, outputPath }) => {
      try {
        const badId = requireUid(instrumentId);
        if (badId) return fail(badId);

        for (let attempt = 0; ; attempt++) {
          const { res, url } = await archiveFetch(
            `/history-trades/${date}?instrumentId=${encodeURIComponent(instrumentId)}`,
          );
          if (res.status === 404) {
            return fail(new Error(`no trades archive for ${date} (weekend/holiday or the archive is not built yet)`));
          }
          if (res.status === 429 && attempt < 2) {
            await sleep(60_000);
            continue;
          }
          if (!res.ok) throw archiveStatusError(`history-trades ${date}`, res, url);

          const parts: string[] = [];
          let records = appendArchiveCsv(new Uint8Array(await res.arrayBuffer()), parts);
          const body = parts.join("\n") + "\n";
          const headerLine = body.slice(0, body.indexOf("\n"));
          if (headerLine.startsWith("TRADE_TS")) records -= 1; // the file carries its own header
          const rel = outputPath ?? `trades_${instrumentId}_${date}.csv`;
          const { savedTo, bytes } = await writeRaw(rel, body);
          return ok({ savedTo, format: "csv", records, bytes, date, header: headerLine.trim() });
        }
      } catch (e) {
        return fail(e);
      }
    },
  );
}
