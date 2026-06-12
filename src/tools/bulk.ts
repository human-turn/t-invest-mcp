import { unzipSync, gunzipSync } from "fflate";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../client.js";
import { ok, fail, sleep, notifyProgress, type ProgressCtx } from "../helpers.js";
import { writeRaw, createSafeWriter } from "../output.js";
import { resolveInstrumentRef } from "../instruments-cache.js";

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

/** Build an honest error from collected failures, distinguishing token / rate-limit / host / param issues */
function archiveError(label: string, failures: string[]): Error {
  const joined = failures.join("; ");
  let hint: string;
  if (/HTTP 40[13]\b/.test(joined)) {
    hint = "the archive endpoint rejected the token — use a production T-Invest token (sandbox tokens have no archive access)";
  } else if (/HTTP 429\b/.test(joined)) {
    hint = "rate limit (30 files/min per IP) — wait a minute and retry";
  } else if (/HTTP 5\d\d\b/.test(joined)) {
    hint = "archive host error (5xx) — try again later";
  } else if (/HTTP \d/.test(joined)) {
    hint = "make sure instrumentId is an instrument UID and the year/date is within the available range (see get_history_archive_years)";
  } else {
    hint = "check network/TLS access to the archive hosts";
  }
  return new Error(`${label}: ${joined} — ${hint}`);
}

/**
 * GET an archive endpoint with central 429-retry and network-level host fallback.
 * Returns a Response with status 2xx or 404 (caller distinguishes); throws an honest
 * error for every other outcome. The host is pinned only on a meaningful answer (2xx/404).
 */
async function archiveRequest(pathAndQuery: string, label: string): Promise<Response> {
  const hosts = archiveHost ? [archiveHost, ...ARCHIVE_HOSTS.filter((h) => h !== archiveHost)] : ARCHIVE_HOSTS;
  const failures: string[] = [];

  for (const host of hosts) {
    const url = `${host}${pathAndQuery}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${config.token}` } });
      } catch (e) {
        const cause = (e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message;
        failures.push(`${url}: ${cause}`);
        break; // network failure — try next host
      }
      if (res.ok || res.status === 404) {
        archiveHost = host;
        return res;
      }
      if (res.status === 429 && attempt < 2) {
        await sleep(60_000);
        continue;
      }
      failures.push(`${url}: HTTP ${res.status}`);
      break; // error status — try next host (do not pin)
    }
  }
  throw archiveError(label, failures);
}

async function fetchYearZip(uid: string, year: number): Promise<Uint8Array | null> {
  const res = await archiveRequest(`/history-data?instrumentId=${encodeURIComponent(uid)}&year=${year}`, `history-data ${year}`);
  if (res.status === 404) return null; // no archive for this year
  return new Uint8Array(await res.arrayBuffer());
}

/** Decode an archive body (ZIP 'PK', gzip 1f8b, or plain text) into CSV text + row count */
function archiveToCsv(bytes: Uint8Array): { text: string; rows: number } {
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const chunks: string[] = [];
    let rows = 0;
    for (const name of Object.keys(files).sort()) {
      const t = new TextDecoder().decode(files[name]).trim();
      if (!t) continue;
      chunks.push(t);
      rows += t.split("\n").length;
    }
    return { text: chunks.join("\n"), rows };
  }
  const raw = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const text = new TextDecoder().decode(raw).trim();
  return { text, rows: text ? text.split("\n").length : 0 };
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
  const res = await archiveRequest(`/candles-instruments-index/instrument-type/${instrumentType}`, "archive index");
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

        const rel = outputPath ?? `history_1min_${instrumentId}_${yearFrom}-${lastYear}.csv`;
        // stream each year straight to disk so peak memory is ~one year, not the whole dataset
        const writer = await createSafeWriter(rel);
        let bytes = 0;
        try {
          await writer.write(CANDLE_CSV_HEADER + "\n");
          const downloadedYears: number[] = [];
          const skippedYears: number[] = [];
          let records = 0;

          for (let y = yearFrom, i = 0; y <= lastYear; y++, i++) {
            const zip = await fetchYearZip(instrumentId, y);
            if (zip) {
              const { text, rows } = archiveToCsv(zip);
              if (text) {
                await writer.write(text + "\n");
                records += rows;
                downloadedYears.push(y);
              } else {
                skippedYears.push(y);
              }
            } else {
              skippedYears.push(y);
            }
            await notifyProgress(extra as unknown as ProgressCtx, i + 1, lastYear - yearFrom + 1, `archive ${y}: ${records} candles so far`);
            if (y < lastYear) await sleep(THROTTLE_MS);
          }

          bytes = await writer.close();
          if (records === 0) {
            await writer.remove();
            return fail(
              new Error(`no archives found for ${instrumentId} in ${yearFrom}-${lastYear} — check available years via get_history_archive_years`),
            );
          }
          return ok({ savedTo: writer.savedTo, format: "csv", records, bytes, downloadedYears, skippedYears, header: CANDLE_CSV_HEADER });
        } catch (e) {
          await writer.close().catch(() => {});
          await writer.remove().catch(() => {});
          throw e;
        }
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
        // strict resolve: a genuine not-found → "unknown UID"; an API error rethrows so fail() shows the gRPC hint
        const ref = await resolveInstrumentRef(instrumentId);
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

        const res = await archiveRequest(`/history-trades/${date}?instrumentId=${encodeURIComponent(instrumentId)}`, `history-trades ${date}`);
        if (res.status === 404) {
          return fail(new Error(`no trades archive for ${date} (weekend/holiday or the archive is not built yet)`));
        }
        const { text, rows } = archiveToCsv(new Uint8Array(await res.arrayBuffer()));
        const headerLine = text.slice(0, text.indexOf("\n")).trim();
        const records = headerLine.startsWith("TRADE_TS") ? rows - 1 : rows; // file carries its own header
        const rel = outputPath ?? `trades_${instrumentId}_${date}.csv`;
        const { savedTo, bytes } = await writeRaw(rel, text + "\n");
        return ok({ savedTo, format: "csv", records, bytes, date, header: headerLine });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
