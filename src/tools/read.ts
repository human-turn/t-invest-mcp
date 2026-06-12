import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PortfolioRequest_CurrencyRequest,
  OperationState,
  CandleInterval,
  InstrumentIdType,
  GetBondEventsRequest_EventType,
  accountTypeToJSON,
  accountStatusToJSON,
  securityTradingStatusToJSON,
  recommendationToJSON,
  couponTypeToJSON,
  getBondEventsRequest_EventTypeToJSON,
  orderDirectionToJSON,
  orderTypeToJSON,
  orderExecutionReportStatusToJSON,
} from "@tinkoff/invest-js";
import { getClient, config } from "../client.js";
import { getInstrumentRef } from "../instruments-cache.js";
import {
  ok,
  fail,
  toNumber,
  toMsk,
  parseDate,
  daysFromNow,
  enumLabel,
  notifyProgress,
  withRateLimitRetry,
  computeChunks,
  type ProgressCtx,
} from "../helpers.js";
import { outputParams, deliver } from "../output.js";

const RO = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const MAX_CANDLES = 1500;
const MAX_SEARCH_RESULTS = 30;
const OPERATIONS_PAGE = 1000;

const CANDLE_INTERVALS = {
  "1min": CandleInterval.CANDLE_INTERVAL_1_MIN,
  "5min": CandleInterval.CANDLE_INTERVAL_5_MIN,
  "15min": CandleInterval.CANDLE_INTERVAL_15_MIN,
  hour: CandleInterval.CANDLE_INTERVAL_HOUR,
  day: CandleInterval.CANDLE_INTERVAL_DAY,
  week: CandleInterval.CANDLE_INTERVAL_WEEK,
  month: CandleInterval.CANDLE_INTERVAL_MONTH,
} as const;

/** Max request range per interval (T-Invest docs, intro/load_history), days */
const INTERVAL_MAX_DAYS: Record<keyof typeof CANDLE_INTERVALS, number> = {
  "1min": 1,
  "5min": 7,
  "15min": 21,
  hour: 90,
  day: 2190, // 6 years
  week: 1825, // 5 years
  month: 3650, // 10 years
};

/** Fundamentals API returns 0 for missing indicators — expose as null to avoid fake zeros */
const orNull = (x: number | undefined): number | null => (x ? x : null);

/** Bonds are quoted in % of nominal, futures in points — surface the unit next to prices */
async function priceUnit(uid: string): Promise<"percent_of_nominal" | "points" | "currency" | undefined> {
  const ref = await getInstrumentRef(uid);
  if (!ref) return undefined;
  if (ref.instrumentType === "bond") return "percent_of_nominal";
  if (ref.instrumentType === "futures") return "points";
  return "currency";
}

/** Numeric gRPC operation type → readable enum name */
const OP_TYPE_MAP: Record<number, string> = {
  0: "UNSPECIFIED", 1: "INPUT", 2: "BOND_TAX", 3: "OUTPUT_SECURITIES",
  4: "OVERNIGHT", 5: "TAX", 6: "BOND_REPAYMENT_FULL", 7: "SELL_CARD",
  8: "DIVIDEND_TAX", 9: "OUTPUT", 10: "BOND_REPAYMENT", 11: "TAX_CORRECTION",
  12: "SERVICE_FEE", 13: "BENEFIT_TAX", 14: "MARGIN_FEE", 15: "BUY",
  16: "BUY_CARD", 17: "INPUT_SECURITIES", 18: "SELL_MARGIN", 19: "BROKER_FEE",
  20: "BUY_MARGIN", 21: "DIVIDEND", 22: "SELL", 23: "COUPON",
  24: "SUCCESS_FEE", 25: "DIVIDEND_TRANSFER", 26: "ACCRUING_VARMARGIN",
  27: "WRITING_OFF_VARMARGIN", 28: "DELIVERY_BUY", 29: "DELIVERY_SELL",
  30: "TRACK_MFEE", 31: "TRACK_PFEE", 32: "TAX_PROGRESSIVE",
  33: "BOND_TAX_PROGRESSIVE", 34: "DIVIDEND_TAX_PROGRESSIVE",
  35: "BENEFIT_TAX_PROGRESSIVE", 36: "TAX_CORRECTION_PROGRESSIVE",
  37: "TAX_REPO_PROGRESSIVE", 38: "TAX_REPO", 39: "TAX_REPO_HOLD",
  40: "TAX_REPO_REFUND", 41: "TAX_REPO_HOLD_PROGRESSIVE",
  42: "TAX_REPO_REFUND_PROGRESSIVE", 43: "DIV_EXT",
  44: "TAX_CORRECTION_COUPON", 45: "CASH_FEE", 46: "OUT_FEE",
  50: "OUTPUT_SWIFT", 51: "INPUT_SWIFT", 53: "OUTPUT_ACQUIRING",
  54: "INPUT_ACQUIRING", 55: "OUTPUT_PENALTY", 56: "ADVICE_FEE",
  57: "TRANS_IIS_BS", 58: "TRANS_BS_BS", 59: "OUT_MULTI",
  60: "INP_MULTI", 61: "OVER_PLACEMENT", 62: "OVER_COM",
  63: "OVER_INCOME", 64: "OPTION_EXPIRATION", 65: "FUTURE_EXPIRATION",
};

function normalizeOpType(type: string | number): string {
  if (typeof type === "number") return OP_TYPE_MAP[type] ?? String(type);
  if (typeof type === "string" && type.startsWith("OPERATION_TYPE_")) return type.slice(15);
  return String(type);
}

type OperationRow = Record<string, unknown>;

function mapOperation(op: {
  id: string;
  name: string;
  type: string | number;
  date?: Date | string | undefined;
  instrumentUid: string;
  instrumentType: string;
  payment?: { currency?: string } | undefined;
  price?: unknown;
  commission?: unknown;
  quantityDone: number | string;
}): OperationRow {
  return {
    id: op.id,
    name: op.name,
    type: normalizeOpType(op.type),
    date: toMsk(op.date),
    instrumentUid: op.instrumentUid,
    instrumentType: op.instrumentType,
    payment: toNumber(op.payment as never),
    price: toNumber(op.price as never),
    commission: toNumber(op.commission as never),
    currency: op.payment?.currency ?? "rub",
    quantity: op.quantityDone,
  };
}

export function registerReadTools(server: McpServer): void {
  const sandboxNote = config.sandbox
    ? " SANDBOX MODE: every account returned here is a sandbox account regardless of its type (type reflects the account kind — TINKOFF is a regular brokerage account, TINKOFF_IIS an individual investment account; there is no special SANDBOX type)."
    : "";

  server.registerTool(
    "get_accounts",
    {
      title: "Get Accounts",
      description: `List all brokerage accounts of the token owner (id, name, type, status). Start here: accountId is required by portfolio/operations/orders tools.${sandboxNote}`,
      inputSchema: { ...outputParams },
      annotations: RO,
    },
    async ({ outputPath, outputFormat }) => {
      try {
        const { accounts } = await getClient().users.getAccounts({});
        const rows = accounts.map((a) => ({
          id: a.id,
          name: a.name,
          type: enumLabel(accountTypeToJSON, a.type, "ACCOUNT_TYPE_"),
          status: enumLabel(accountStatusToJSON, a.status, "ACCOUNT_STATUS_"),
        }));
        return await deliver(rows, rows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_portfolio",
    {
      title: "Get Portfolio",
      description:
        "Portfolio summary in RUB: totals by asset class, expected yield, and all positions enriched with ticker/name (quantity, average and current price, accrued interest for bonds). csv output writes the positions array.",
      inputSchema: {
        accountId: z.string().describe("Account ID from get_accounts"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ accountId, outputPath, outputFormat }) => {
      try {
        const response = await getClient().operations.getPortfolio({
          accountId,
          currency: PortfolioRequest_CurrencyRequest.RUB,
        });

        const positions = await Promise.all(
          (response.positions ?? []).map(async (p) => {
            const ref = await getInstrumentRef(p.instrumentUid);
            return {
              instrumentUid: p.instrumentUid,
              ticker: ref?.ticker ?? "",
              name: ref?.name ?? "",
              instrumentType: p.instrumentType,
              quantity: toNumber(p.quantity),
              lot: ref?.lot ?? 1,
              averagePrice: toNumber(p.averagePositionPrice),
              currentPrice: toNumber(p.currentPrice),
              currency: p.averagePositionPrice?.currency ?? "rub",
              accruedInterest: toNumber(p.currentNkd),
            };
          }),
        );

        const totalPortfolio = toNumber(response.totalAmountPortfolio);
        // API returns portfolio-level expectedYield as a percentage (11.78 = +11.78%)
        const yieldPercent = toNumber(response.expectedYield);
        const yieldRub = yieldPercent !== 0 ? (totalPortfolio * yieldPercent) / (100 + yieldPercent) : 0;

        const data = {
          totalShares: toNumber(response.totalAmountShares),
          totalBonds: toNumber(response.totalAmountBonds),
          totalEtf: toNumber(response.totalAmountEtf),
          totalCurrencies: toNumber(response.totalAmountCurrencies),
          totalPortfolio,
          yieldPercent,
          yieldRub,
          positions,
        };
        return await deliver(data, positions, { outputPath, outputFormat }, { totalPortfolio, yieldPercent });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_operations",
    {
      title: "Get Operations",
      description:
        "Executed account operations (trades, dividends, coupons, taxes, fees) with cursor pagination. Default period: last 365 days. With outputPath the server automatically fetches ALL pages to the end of the period and writes the full history to the file.",
      inputSchema: {
        accountId: z.string().describe("Account ID from get_accounts"),
        instrumentId: z.string().optional().describe("Filter by instrument UID"),
        from: z.string().optional().describe("Period start, ISO 8601 (default: 1 year ago)"),
        to: z.string().optional().describe("Period end, ISO 8601 (default: now)"),
        limit: z.number().int().min(1).max(1000).default(100).describe("Page size (inline mode)"),
        cursor: z.string().optional().describe("Cursor from the previous response (nextCursor)"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ accountId, instrumentId, from, to, limit, cursor, outputPath, outputFormat }, extra) => {
      try {
        const fromD = parseDate(from, daysFromNow(-365));
        const toD = parseDate(to, new Date());
        const baseRequest = {
          accountId,
          instrumentId: instrumentId ?? "",
          from: fromD,
          to: toD,
          operationTypes: [],
          state: OperationState.OPERATION_STATE_EXECUTED,
          withoutCommissions: false,
          withoutTrades: true,
          withoutOvernights: true,
        };

        if (outputPath) {
          // file mode: drain the cursor to capture the complete history
          const items: OperationRow[] = [];
          let pageCursor = cursor ?? "";
          let page = 0;
          for (;;) {
            const response = await withRateLimitRetry(() =>
              getClient().operations.getOperationsByCursor({
                ...baseRequest,
                limit: OPERATIONS_PAGE,
                cursor: pageCursor,
              }),
            );
            items.push(...response.items.map(mapOperation));
            page++;
            await notifyProgress(
              extra as unknown as ProgressCtx,
              page,
              undefined,
              `operations: page ${page}, ${items.length} items`,
            );
            if (!response.hasNext) break;
            pageCursor = response.nextCursor;
          }
          return await deliver({ items }, items, { outputPath, outputFormat }, {
            range: { from: toMsk(fromD), to: toMsk(toD) },
          });
        }

        const response = await getClient().operations.getOperationsByCursor({
          ...baseRequest,
          limit,
          cursor: cursor ?? "",
        });
        return ok({
          hasNext: response.hasNext,
          nextCursor: response.nextCursor,
          items: response.items.map(mapOperation),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "find_instrument",
    {
      title: "Find Instrument",
      description: "Search instruments by ticker, ISIN, FIGI or name. Returns UIDs required by other tools.",
      inputSchema: {
        query: z.string().min(1).describe("Ticker (SBER), ISIN, FIGI or part of the name"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ query, outputPath, outputFormat }) => {
      try {
        const { instruments } = await getClient().instruments.findInstrument({
          query,
          apiTradeAvailableFlag: true,
        });
        const all = instruments.map((i) => ({
          uid: i.uid,
          ticker: i.ticker,
          name: i.name,
          instrumentType: i.instrumentType,
          classCode: i.classCode,
        }));
        if (outputPath) {
          return await deliver({ total: all.length, items: all }, all, { outputPath, outputFormat });
        }
        return ok({
          total: all.length,
          truncated: all.length > MAX_SEARCH_RESULTS,
          items: all.slice(0, MAX_SEARCH_RESULTS),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_instrument",
    {
      title: "Get Instrument Details",
      description:
        "Instrument card by UID: ticker, ISIN, currency, lot size, exchange, trading status, country of risk, assetUid (needed for get_asset_fundamentals). For bonds also returns a bond block: nominal, maturity, coupon frequency, accrued interest — bond market prices are quoted in % of this nominal.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID from find_instrument or portfolio"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentId, outputPath, outputFormat }) => {
      try {
        const { instrument } = await getClient().instruments.getInstrumentBy({
          idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
          id: instrumentId,
        });
        if (!instrument) return ok({ found: false });
        const card: Record<string, unknown> = {
          uid: instrument.uid,
          assetUid: instrument.assetUid,
          ticker: instrument.ticker,
          name: instrument.name,
          classCode: instrument.classCode,
          isin: instrument.isin,
          currency: instrument.currency,
          lot: instrument.lot,
          exchange: instrument.exchange,
          instrumentType: instrument.instrumentType,
          tradingStatus: enumLabel(securityTradingStatusToJSON, instrument.tradingStatus, "SECURITY_TRADING_STATUS_"),
          countryOfRisk: instrument.countryOfRisk,
          countryOfRiskName: instrument.countryOfRiskName,
        };

        if (instrument.instrumentType === "bond") {
          const { instrument: bond } = await getClient().instruments.bondBy({
            idType: InstrumentIdType.INSTRUMENT_ID_TYPE_UID,
            id: instrumentId,
          });
          if (bond) {
            card.bond = {
              nominal: toNumber(bond.nominal),
              nominalCurrency: bond.nominal?.currency ?? "",
              accruedInterest: toNumber(bond.aciValue),
              maturityDate: toMsk(bond.maturityDate),
              couponQuantityPerYear: bond.couponQuantityPerYear,
              floatingCouponFlag: bond.floatingCouponFlag,
              amortizationFlag: bond.amortizationFlag,
            };
          }
        }
        return await deliver(card, null, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_last_prices",
    {
      title: "Get Last Prices",
      description:
        "Last known prices for a batch of instruments. Response order mirrors the request; unknown UIDs come back with found:false. priceUnit flags the quote unit: bonds are quoted in % of nominal (see get_instrument bond.nominal), futures in points.",
      inputSchema: {
        instrumentIds: z.array(z.string()).min(1).max(100).describe("Instrument UIDs"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentIds, outputPath, outputFormat }) => {
      try {
        const { lastPrices } = await getClient().marketdata.getLastPrices({
          instrumentId: instrumentIds,
        });
        // API silently drops/empties unknown UIDs — key the response off the request instead
        const byUid = new Map(lastPrices.filter((lp) => lp.instrumentUid).map((lp) => [lp.instrumentUid, lp]));
        const rows = await Promise.all(
          instrumentIds.map(async (id) => {
            const lp = byUid.get(id);
            return lp
              ? {
                  instrumentUid: id,
                  found: true,
                  price: toNumber(lp.price),
                  priceUnit: await priceUnit(id),
                  time: toMsk(lp.time),
                }
              : { instrumentUid: id, found: false };
          }),
        );
        return await deliver(rows, rows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_candles",
    {
      title: "Get Candles",
      description: `OHLCV candles for an instrument. Default: daily candles for the last year. Inline mode returns at most ${MAX_CANDLES} most recent candles (truncated flag). With outputPath the server fetches the WHOLE range, splitting it into chunks within API limits (day candles up to 6 years per request, 1min up to 1 day), and writes everything to the file. priceUnit: bonds are quoted in % of nominal, futures in points.`,
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID"),
        from: z.string().optional().describe("Period start, ISO 8601 (default: 1 year ago)"),
        to: z.string().optional().describe("Period end, ISO 8601 (default: now)"),
        interval: z.enum(["1min", "5min", "15min", "hour", "day", "week", "month"]).default("day"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentId, from, to, interval, outputPath, outputFormat }, extra) => {
      try {
        const fromD = parseDate(from, daysFromNow(-365));
        const toD = parseDate(to, new Date());

        let rawCandles;
        if (outputPath) {
          // file mode: chunk the range to respect per-request limits and fetch everything
          const chunks = computeChunks(fromD, toD, INTERVAL_MAX_DAYS[interval]);
          rawCandles = [];
          for (let i = 0; i < chunks.length; i++) {
            const part = await withRateLimitRetry(() =>
              getClient().marketdata.getCandles({
                instrumentId,
                from: chunks[i].from,
                to: chunks[i].to,
                interval: CANDLE_INTERVALS[interval],
              }),
            );
            rawCandles.push(...part.candles);
            await notifyProgress(
              extra as unknown as ProgressCtx,
              i + 1,
              chunks.length,
              `candles: chunk ${i + 1}/${chunks.length}, ${rawCandles.length} total`,
            );
          }
        } else {
          ({ candles: rawCandles } = await getClient().marketdata.getCandles({
            instrumentId,
            from: fromD,
            to: toD,
            interval: CANDLE_INTERVALS[interval],
          }));
        }

        const mapped = rawCandles.map((c) => ({
          time: toMsk(c.time),
          open: toNumber(c.open),
          high: toNumber(c.high),
          low: toNumber(c.low),
          close: toNumber(c.close),
          volume: c.volume,
        }));
        const unit = await priceUnit(instrumentId);

        if (outputPath) {
          return await deliver({ priceUnit: unit, candles: mapped }, mapped, { outputPath, outputFormat }, {
            priceUnit: unit,
            interval,
            range: { from: toMsk(fromD), to: toMsk(toD) },
          });
        }
        return ok({
          total: mapped.length,
          truncated: mapped.length > MAX_CANDLES,
          priceUnit: unit,
          candles: mapped.slice(-MAX_CANDLES),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_order_book",
    {
      title: "Get Order Book",
      description:
        "Order book (bids/asks) for an instrument, with last/close price and trading limits. priceUnit flags the quote unit: bonds are quoted in % of nominal (see get_instrument bond.nominal), futures in points.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID"),
        depth: z.number().int().min(1).max(50).default(10),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentId, depth, outputPath, outputFormat }) => {
      try {
        const r = await getClient().marketdata.getOrderBook({ instrumentId, depth });
        const data = {
          depth: r.depth,
          priceUnit: await priceUnit(instrumentId),
          lastPrice: toNumber(r.lastPrice),
          closePrice: toNumber(r.closePrice),
          limitUp: toNumber(r.limitUp),
          limitDown: toNumber(r.limitDown),
          bids: r.bids.map((b) => ({ price: toNumber(b.price), quantity: b.quantity })),
          asks: r.asks.map((a) => ({ price: toNumber(a.price), quantity: a.quantity })),
        };
        return await deliver(data, null, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_dividends",
    {
      title: "Get Dividends",
      description: "Dividend history and announcements for a share. Default period: -1 year to +1 year.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID"),
        from: z.string().optional().describe("Period start, ISO 8601 (default: 1 year ago)"),
        to: z.string().optional().describe("Period end, ISO 8601 (default: 1 year ahead)"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentId, from, to, outputPath, outputFormat }) => {
      try {
        const { dividends } = await getClient().instruments.getDividends({
          instrumentId,
          from: parseDate(from, daysFromNow(-365)),
          to: parseDate(to, daysFromNow(365)),
        });
        const rows = dividends.map((d) => ({
          dividendNet: toNumber(d.dividendNet),
          currency: d.dividendNet?.currency ?? "rub",
          yieldPercent: toNumber(d.yieldValue),
          declaredDate: toMsk(d.declaredDate),
          lastBuyDate: toMsk(d.lastBuyDate),
          recordDate: toMsk(d.recordDate),
          paymentDate: toMsk(d.paymentDate),
          dividendType: d.dividendType,
          regularity: d.regularity,
        }));
        return await deliver(rows, rows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_bond_coupons",
    {
      title: "Get Bond Coupons",
      description: "Coupon schedule for a bond. Default period: -1 year to +1 year.",
      inputSchema: {
        instrumentId: z.string().describe("Bond UID"),
        from: z.string().optional().describe("Period start, ISO 8601 (default: 1 year ago)"),
        to: z.string().optional().describe("Period end, ISO 8601 (default: 1 year ahead)"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentId, from, to, outputPath, outputFormat }) => {
      try {
        const { events } = await getClient().instruments.getBondCoupons({
          instrumentId,
          from: parseDate(from, daysFromNow(-365)),
          to: parseDate(to, daysFromNow(365)),
        });
        const rows = events.map((c) => ({
          couponNumber: c.couponNumber,
          couponDate: toMsk(c.couponDate),
          payOneBond: toNumber(c.payOneBond),
          currency: c.payOneBond?.currency ?? "rub",
          couponType: enumLabel(couponTypeToJSON, c.couponType, "COUPON_TYPE_"),
          fixDate: toMsk(c.fixDate),
          couponStartDate: toMsk(c.couponStartDate),
          couponEndDate: toMsk(c.couponEndDate),
          couponPeriodDays: c.couponPeriod,
        }));
        return await deliver(rows, rows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_accrued_interests",
    {
      title: "Get Accrued Interests",
      description: "Accrued interest (НКД) history for a bond. Default period: last 30 days.",
      inputSchema: {
        instrumentId: z.string().describe("Bond UID"),
        from: z.string().optional().describe("Period start, ISO 8601 (default: 30 days ago)"),
        to: z.string().optional().describe("Period end, ISO 8601 (default: now)"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentId, from, to, outputPath, outputFormat }) => {
      try {
        const { accruedInterests } = await getClient().instruments.getAccruedInterests({
          instrumentId,
          from: parseDate(from, daysFromNow(-30)),
          to: parseDate(to, new Date()),
        });
        const rows = accruedInterests.map((ai) => ({
          date: toMsk(ai.date),
          value: toNumber(ai.value),
          valuePercent: toNumber(ai.valuePercent),
          nominal: toNumber(ai.nominal),
        }));
        return await deliver(rows, rows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_bond_events",
    {
      title: "Get Bond Events",
      description:
        "Bond lifecycle events: coupons, calls/offers, maturity, conversion. Key tool for tracking offer (оферта) and repayment dates.",
      inputSchema: {
        instrumentId: z.string().describe("Bond UID"),
        type: z
          .enum(["coupon", "call", "maturity", "conversion"])
          .optional()
          .describe("Event type filter (default: all)"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentId, type, outputPath, outputFormat }) => {
      try {
        const typeMap = {
          coupon: GetBondEventsRequest_EventType.EVENT_TYPE_CPN,
          call: GetBondEventsRequest_EventType.EVENT_TYPE_CALL,
          maturity: GetBondEventsRequest_EventType.EVENT_TYPE_MTY,
          conversion: GetBondEventsRequest_EventType.EVENT_TYPE_CONV,
        } as const;
        const { events } = await getClient().instruments.getBondEvents({
          instrumentId,
          type: type ? typeMap[type] : GetBondEventsRequest_EventType.EVENT_TYPE_UNSPECIFIED,
        });
        const rows = events.map((e) => ({
          eventDate: toMsk(e.eventDate),
          eventType: enumLabel(getBondEventsRequest_EventTypeToJSON, e.eventType, "EVENT_TYPE_"),
          eventTotalVol: toNumber(e.eventTotalVol),
          fixDate: toMsk(e.fixDate),
          rateDate: toMsk(e.rateDate),
          payDate: toMsk(e.payDate),
        }));
        return await deliver(rows, rows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_asset_fundamentals",
    {
      title: "Get Asset Fundamentals",
      description:
        "Fundamental indicators for assets: market cap, P/E, P/B, EV/EBITDA, ROE/ROA/ROIC, margins, debt ratios, dividend yield, 52-week range. Takes assetUid (NOT instrument UID) — get it from get_instrument. Indicators not applicable to the asset (e.g. EV/EBITDA for banks) are null.",
      inputSchema: {
        assetUids: z.array(z.string()).min(1).max(50).describe("Asset UIDs (assetUid field from get_instrument)"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ assetUids, outputPath, outputFormat }) => {
      try {
        const { fundamentals } = await getClient().instruments.getAssetFundamentals({
          assets: assetUids,
        });
        const rows = fundamentals.map((f) => ({
          assetUid: f.assetUid,
          currency: f.currency,
          marketCapitalization: orNull(f.marketCapitalization),
          highPriceLast52Weeks: orNull(f.highPriceLast52Weeks),
          lowPriceLast52Weeks: orNull(f.lowPriceLast52Weeks),
          beta: orNull(f.beta),
          freeFloat: orNull(f.freeFloat),
          peRatioTtm: orNull(f.peRatioTtm),
          priceToSalesTtm: orNull(f.priceToSalesTtm),
          priceToBookTtm: orNull(f.priceToBookTtm),
          priceToFreeCashFlowTtm: orNull(f.priceToFreeCashFlowTtm),
          evToEbitdaMrq: orNull(f.evToEbitdaMrq),
          netMarginMrq: orNull(f.netMarginMrq),
          roe: orNull(f.roe),
          roa: orNull(f.roa),
          roic: orNull(f.roic),
          totalDebtToEquityMrq: orNull(f.totalDebtToEquityMrq),
          totalDebtToEbitdaMrq: orNull(f.totalDebtToEbitdaMrq),
          currentRatioMrq: orNull(f.currentRatioMrq),
          revenueTtm: orNull(f.revenueTtm),
          ebitdaTtm: orNull(f.ebitdaTtm),
          netIncomeTtm: orNull(f.netIncomeTtm),
          epsTtm: orNull(f.epsTtm),
          freeCashFlowTtm: orNull(f.freeCashFlowTtm),
          dividendYieldDailyTtm: orNull(f.dividendYieldDailyTtm),
          dividendRateTtm: orNull(f.dividendRateTtm),
          dividendsPerShare: orNull(f.dividendsPerShare),
          forwardAnnualDividendYield: orNull(f.forwardAnnualDividendYield),
          sharesOutstanding: orNull(f.sharesOutstanding),
        }));
        return await deliver(rows, rows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_forecasts",
    {
      title: "Get Analyst Forecasts",
      description:
        "Analyst consensus and per-company price targets/recommendations for an instrument. csv output writes the targets array.",
      inputSchema: {
        instrumentId: z.string().describe("Instrument UID"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ instrumentId, outputPath, outputFormat }) => {
      try {
        const { consensus, targets } = await getClient().instruments.getForecastBy({
          instrumentId,
        });
        const targetRows = targets.map((t) => ({
          company: t.company,
          recommendation: enumLabel(recommendationToJSON, t.recommendation, "RECOMMENDATION_"),
          currency: t.currency,
          currentPrice: toNumber(t.currentPrice),
          targetPrice: toNumber(t.targetPrice),
          priceChangeRel: toNumber(t.priceChangeRel),
          recommendationDate: toMsk(t.recommendationDate),
        }));
        const data = {
          consensus: consensus
            ? {
                recommendation: enumLabel(recommendationToJSON, consensus.recommendation, "RECOMMENDATION_"),
                currency: consensus.currency,
                currentPrice: toNumber(consensus.currentPrice),
                consensusPrice: toNumber(consensus.consensus),
                minTarget: toNumber(consensus.minTarget),
                maxTarget: toNumber(consensus.maxTarget),
                priceChangeRel: toNumber(consensus.priceChangeRel),
              }
            : null,
          targets: targetRows,
        };
        return await deliver(data, targetRows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_trading_schedules",
    {
      title: "Get Trading Schedules",
      description: "Exchange trading schedules for the next 7 days (trading days, session start/end in MSK).",
      inputSchema: {
        exchange: z.string().optional().describe("Exchange code, e.g. MOEX (default: all exchanges)"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ exchange, outputPath, outputFormat }) => {
      try {
        const { exchanges } = await getClient().instruments.tradingSchedules({
          exchange: exchange ?? "",
          from: new Date(),
          to: daysFromNow(7),
        });
        const data = exchanges.map((ex) => ({
          exchange: ex.exchange,
          days: ex.days.map((d) => ({
            date: toMsk(d.date).slice(0, 10),
            isTradingDay: d.isTradingDay,
            startTime: toMsk(d.startTime),
            endTime: toMsk(d.endTime),
          })),
        }));
        return await deliver(data, null, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_active_orders",
    {
      title: "Get Active Orders",
      description: "Active (not yet executed) orders for an account, enriched with ticker/name.",
      inputSchema: {
        accountId: z.string().describe("Account ID from get_accounts"),
        ...outputParams,
      },
      annotations: RO,
    },
    async ({ accountId, outputPath, outputFormat }) => {
      try {
        const { orders } = await getClient().orders.getOrders({ accountId });
        const rows = await Promise.all(
          orders.map(async (o) => {
            const ref = await getInstrumentRef(o.instrumentUid);
            return {
              orderId: o.orderId,
              instrumentUid: o.instrumentUid,
              ticker: ref?.ticker ?? "",
              name: ref?.name ?? "",
              direction: enumLabel(orderDirectionToJSON, o.direction, "ORDER_DIRECTION_"),
              orderType: enumLabel(orderTypeToJSON, o.orderType, "ORDER_TYPE_"),
              status: enumLabel(orderExecutionReportStatusToJSON, o.executionReportStatus, "EXECUTION_REPORT_STATUS_"),
              lotsRequested: o.lotsRequested,
              lotsExecuted: o.lotsExecuted,
              initialPrice: toNumber(o.initialSecurityPrice),
              totalAmount: toNumber(o.totalOrderAmount),
              orderDate: toMsk(o.orderDate),
            };
          }),
        );
        return await deliver(rows, rows, { outputPath, outputFormat });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
