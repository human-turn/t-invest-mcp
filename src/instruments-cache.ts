import { InstrumentIdType } from "@tinkoff/invest-js";
import { getClient } from "./client.js";

export interface InstrumentRef {
  uid: string;
  ticker: string;
  name: string;
  instrumentType: string;
  currency: string;
  lot: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

// Cache the in-flight promise (not the resolved value) so concurrent lookups of the
// same uid share one request. Resolves to null for a genuine not-found; rejects on API error.
const cache = new Map<string, { promise: Promise<InstrumentRef | null>; at: number }>();

async function load(uid: string): Promise<InstrumentRef | null> {
  const { instrument } = await getClient().instruments.getInstrumentBy({
    idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
    id: uid,
  });
  if (!instrument) return null;
  return {
    uid,
    ticker: instrument.ticker,
    name: instrument.name,
    instrumentType: instrument.instrumentType,
    currency: instrument.currency,
    lot: instrument.lot,
  };
}

function cached(uid: string): Promise<InstrumentRef | null> {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;

  const promise = load(uid);
  promise.catch(() => cache.delete(uid)); // failures don't stick — next call retries
  cache.set(uid, { promise, at: Date.now() });

  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value; // Map preserves insertion order
    if (oldest !== undefined) cache.delete(oldest);
  }
  return promise;
}

/** uid → basic instrument info, memoized. Best-effort: returns null on not-found AND on API error. */
export async function getInstrumentRef(uid: string): Promise<InstrumentRef | null> {
  try {
    return await cached(uid);
  } catch {
    return null; // enrichment is best-effort, never fail the parent tool
  }
}

/** Strict variant: returns null ONLY for a genuine not-found; rethrows API errors so the caller can surface the gRPC hint. */
export async function resolveInstrumentRef(uid: string): Promise<InstrumentRef | null> {
  return cached(uid);
}
