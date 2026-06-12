import type { Quotation, MoneyValue } from "@tinkoff/invest-js";

/** Quotation / MoneyValue → number (rounded to 9 dp — kills float artifacts of units + nano/1e9) */
export function toNumber(q: Quotation | MoneyValue | undefined | null): number {
  if (!q) return 0;
  const v = (q.units ?? 0) + (q.nano ?? 0) / 1_000_000_000;
  return Number(v.toFixed(9));
}

/** number → Quotation (carries a rounded-up nano into units so |nano| stays ≤ 999_999_999) */
export function toQuotation(value: number): Quotation {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  let units = Math.floor(abs);
  let nano = Math.round((abs - units) * 1_000_000_000);
  if (nano >= 1_000_000_000) {
    units += 1;
    nano -= 1_000_000_000;
  }
  return { units: units * sign, nano: nano * sign };
}

/** number + currency → MoneyValue */
export function toMoneyValue(value: number, currency: string): MoneyValue {
  return { ...toQuotation(value), currency };
}

// Single reusable formatter (creating one per call is the costly part of toLocaleString)
const MSK_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Date/string → ISO string in Moscow wall-time with the ACTUAL offset for that date (UTC+4/DST before 2014) */
export function toMsk(d: Date | string | undefined | null): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  const wall = MSK_FMT.format(date).replace(" ", "T"); // "2026-06-12T13:58:22"
  // offset = (wall interpreted as UTC) − actual instant; correct for any historical MSK offset
  const offsetMin = Math.round((Date.parse(wall + "Z") - date.getTime()) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${wall}${sign}${hh}:${mm}`;
}

/** ts-proto enum decoder → readable label: enumLabel(accountTypeToJSON, 2, "ACCOUNT_TYPE_") → "TINKOFF_IIS" */
export function enumLabel(
  toJson: (v: number) => string,
  value: number | undefined | null,
  prefix: string,
): string {
  if (value == null) return "";
  try {
    const s = toJson(value);
    if (s === "UNRECOGNIZED") return `UNKNOWN_${value}`; // keep the raw code visible
    return s.startsWith(prefix) ? s.slice(prefix.length) : s;
  } catch {
    return `UNKNOWN_${value}`;
  }
}

/** ISO string → Date, with fallback for omitted params */
export function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback;
  const d = new Date(s);
  if (isNaN(d.getTime())) {
    throw new Error(`Invalid date: "${s}" (expected ISO 8601, e.g. 2026-01-31)`);
  }
  return d;
}

export function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Hints for common gRPC status codes from T-Invest API */
const GRPC_HINTS: Record<number, string> = {
  3: "Invalid argument: check parameter values.",
  5: "Not found: check instrumentId/accountId (use find_instrument to resolve tickers to UIDs).",
  7: "Permission denied: the token may lack the required scope (a read-only token cannot trade).",
  8: "Rate limit exceeded: wait a minute and retry.",
  16: "Unauthenticated: token is invalid or expired (T-Invest tokens expire after 3 months of inactivity).",
};

export function fail(error: unknown): ToolResult {
  let msg = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number" && GRPC_HINTS[code]) msg += ` — ${GRPC_HINTS[code]}`;
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry on gRPC RESOURCE_EXHAUSTED (code 8 / 80002 request limit) with a flat backoff */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, retries = 2, backoffMs = 30_000): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 8 && attempt < retries) {
        await sleep(backoffMs);
        continue;
      }
      throw e;
    }
  }
}

/** Map over items with bounded concurrency (caps parallel gRPC fan-out on large batches) */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Minimal shape of the SDK's request handler `extra` we need for progress */
export interface ProgressCtx {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

/** Best-effort MCP progress notification (no-op when the client sent no progressToken) */
export async function notifyProgress(
  extra: ProgressCtx,
  progress: number,
  total: number | undefined,
  message: string,
): Promise<void> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken == null) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, ...(total != null ? { total } : {}), message },
    });
  } catch {
    // progress is cosmetic — never fail the call
  }
}

/** Split [from, to] into chunks of at most maxDays (for GetCandles range limits) */
export function computeChunks(from: Date, to: Date, maxDays: number): Array<{ from: Date; to: Date }> {
  const chunks: Array<{ from: Date; to: Date }> = [];
  const step = maxDays * 86_400_000;
  for (let t = from.getTime(); t < to.getTime(); t += step) {
    chunks.push({ from: new Date(t), to: new Date(Math.min(t + step, to.getTime())) });
  }
  return chunks;
}
