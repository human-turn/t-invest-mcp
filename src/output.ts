import { mkdir, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ok, type ToolResult } from "./helpers.js";

/** Inline responses larger than this get a hint to use outputPath */
const HINT_THRESHOLD = 25_000;

/** Shared schema fragment: every read tool accepts optional file output */
export const outputParams = {
  outputPath: z
    .string()
    .optional()
    .describe(
      "Write the full result to this file (path relative to the output root: TINKOFF_OUTPUT_DIR or server cwd) instead of returning it inline. The response becomes a short summary {savedTo, records, bytes, sample}. Use for bulk data to keep the context clean. For get_candles/get_operations this also enables full-history fetching (chunking/pagination).",
    ),
  outputFormat: z
    .enum(["json", "csv"])
    .optional()
    .describe("File format; default json (or csv if outputPath ends with .csv). csv writes the main flat array of the response."),
};

export interface OutputArgs {
  outputPath?: string;
  outputFormat?: "json" | "csv";
}

export function outputRoot(): string {
  return process.env.TINKOFF_OUTPUT_DIR || process.cwd();
}

/** Resolve a user-supplied relative path strictly inside the output root (no .. / symlink escapes) */
async function resolveSafe(rel: string): Promise<string> {
  const root = path.resolve(outputRoot());
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`outputPath escapes the output root (${root}) — use a relative path inside it`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  const [realParent, realRoot] = await Promise.all([realpath(path.dirname(target)), realpath(root)]);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
    throw new Error("outputPath escapes the output root via a symlink");
  }
  return path.join(realParent, path.basename(target));
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

/** Write raw text into the output root (used by archive downloads) */
export async function writeRaw(rel: string, body: string): Promise<{ savedTo: string; bytes: number }> {
  const file = await resolveSafe(rel);
  await writeFile(file, body, "utf8");
  return { savedTo: file, bytes: Buffer.byteLength(body, "utf8") };
}

/**
 * Deliver a tool result: inline (with a size hint) or to a file with a compact summary.
 * `rows` is the flat array used for csv and record counting; null = csv unsupported.
 */
export async function deliver(
  data: unknown,
  rows: Record<string, unknown>[] | null,
  out: OutputArgs,
  extras: Record<string, unknown> = {},
): Promise<ToolResult> {
  if (!out.outputPath) {
    const res = ok(data);
    if (res.content[0].text.length > HINT_THRESHOLD) {
      res.content[0].text +=
        "\n\nNOTE: large response — pass outputPath to write it to a file and keep the context clean.";
    }
    return res;
  }

  const format = out.outputFormat ?? (out.outputPath.endsWith(".csv") ? "csv" : "json");
  if (format === "csv" && !rows) {
    throw new Error("csv is not supported for this tool's nested response — use outputFormat: json");
  }
  const body = format === "csv" ? toCsv(rows as Record<string, unknown>[]) : JSON.stringify(data, null, 2);
  const { savedTo, bytes } = await writeRaw(out.outputPath, body);

  return ok({
    savedTo,
    format,
    ...(rows ? { records: rows.length, sample: rows.slice(0, 2) } : {}),
    bytes,
    ...extras,
  });
}
