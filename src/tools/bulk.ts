import { unzipSync } from "fflate";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../client.js";
import { ok, fail, sleep, notifyProgress, type ProgressCtx } from "../helpers.js";
import { writeRaw } from "../output.js";

const ARCHIVE_URL = "https://invest-public-api.tbank.ru/history-data";
const CSV_HEADER = "instrumentUid;timeUtc;open;close;high;low;volume";
const THROTTLE_MS = 2_100; // archive endpoint limit: 30 files/min per IP

async function fetchYear(instrumentId: string, year: number): Promise<Uint8Array | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${ARCHIVE_URL}?instrument_id=${encodeURIComponent(instrumentId)}&year=${year}`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (res.status === 404) return null; // no archive for this year
    if (res.status === 429 && attempt < 2) {
      await sleep(60_000);
      continue;
    }
    if (!res.ok) throw new Error(`history-data ${year}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export function registerBulkTools(server: McpServer): void {
  server.registerTool(
    "download_history_archive",
    {
      title: "Download Minute-Candle History Archive",
      description:
        "Bulk-download MINUTE candles for whole years via the REST archive endpoint (1 HTTP request = 1 year) and merge them into a single CSV file in the output root. Far cheaper than get_candles for long minute history. Columns: instrumentUid;timeUtc;open;close;high;low;volume. Archives are rebuilt nightly (no current day). Years with no data are skipped and listed in the summary.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID (or FIGI) from find_instrument"),
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
        const lastYear = yearTo ?? new Date().getFullYear();
        if (lastYear < yearFrom) return fail(new Error("yearTo must be >= yearFrom"));
        const years: number[] = [];
        for (let y = yearFrom; y <= lastYear; y++) years.push(y);

        const parts: string[] = [CSV_HEADER];
        const skippedYears: number[] = [];
        let records = 0;

        for (let i = 0; i < years.length; i++) {
          const zip = await fetchYear(instrumentId, years[i]);
          if (zip) {
            const files = unzipSync(zip);
            for (const name of Object.keys(files).sort()) {
              const text = new TextDecoder().decode(files[name]).trim();
              if (!text) continue;
              parts.push(text);
              records += text.split("\n").length;
            }
          } else {
            skippedYears.push(years[i]);
          }
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
              `no archives found for ${instrumentId} in ${yearFrom}-${lastYear} — check the UID and the instrument's first_1min_candle_date`,
            ),
          );
        }

        const rel = outputPath ?? `history_1min_${instrumentId}_${yearFrom}-${lastYear}.csv`;
        const { savedTo, bytes } = await writeRaw(rel, parts.join("\n") + "\n");
        return ok({ savedTo, format: "csv", records, bytes, years, skippedYears, header: CSV_HEADER });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
