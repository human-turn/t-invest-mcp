import { InstrumentStatus } from "@tinkoff/invest-js";
import { getClient } from "./client.js";

/** Lazy ticker catalog for prompt-argument completions (shares + bonds + etfs, 24h TTL) */

const TTL_MS = 24 * 60 * 60 * 1000;
let tickers: string[] | null = null;
let loadedAt = 0;
let loading: Promise<string[]> | null = null;

async function load(): Promise<string[]> {
  const client = getClient();
  const instrumentStatus = InstrumentStatus.INSTRUMENT_STATUS_BASE;
  const [shares, bonds, etfs] = await Promise.all([
    client.instruments.shares({ instrumentStatus }),
    client.instruments.bonds({ instrumentStatus }),
    client.instruments.etfs({ instrumentStatus }),
  ]);
  const set = new Set<string>();
  for (const list of [shares.instruments, bonds.instruments, etfs.instruments]) {
    for (const i of list) if (i.ticker) set.add(i.ticker.toUpperCase());
  }
  return [...set].sort();
}

export async function completeTicker(prefix: string): Promise<string[]> {
  try {
    if (!tickers || Date.now() - loadedAt > TTL_MS) {
      loading ??= load()
        .then((t) => {
          tickers = t;
          loadedAt = Date.now();
          return t;
        })
        .finally(() => {
          loading = null;
        });
      await loading;
    }
    const p = prefix.toUpperCase();
    return (tickers ?? []).filter((t) => t.startsWith(p)).slice(0, 100);
  } catch {
    return []; // completion must never fail the client
  }
}
