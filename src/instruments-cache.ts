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
const cache = new Map<string, { ref: InstrumentRef; at: number }>();

/** uid → basic instrument info, memoized (used to enrich portfolio/orders) */
export async function getInstrumentRef(uid: string): Promise<InstrumentRef | null> {
  const hit = cache.get(uid);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ref;

  try {
    const { instrument } = await getClient().instruments.getInstrumentBy({
      idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
      id: uid,
    });
    if (!instrument) return null;
    const ref: InstrumentRef = {
      uid,
      ticker: instrument.ticker,
      name: instrument.name,
      instrumentType: instrument.instrumentType,
      currency: instrument.currency,
      lot: instrument.lot,
    };
    cache.set(uid, { ref, at: Date.now() });
    return ref;
  } catch {
    return null; // enrichment is best-effort, never fail the parent tool
  }
}
