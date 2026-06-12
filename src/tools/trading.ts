import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OrderDirection, OrderType, PriceType, orderExecutionReportStatusToJSON } from "@tinkoff/invest-js";
import { getClient, config } from "../client.js";
import { getInstrumentRef } from "../instruments-cache.js";
import { ok, fail, toNumber, toQuotation, toMsk, enumLabel, type ToolResult } from "../helpers.js";

const CONFIRM_TIMEOUT_MS = 120_000;

/**
 * Human confirmation via MCP elicitation before a trade goes out.
 * Returns null when confirmed; a ready-to-return error result otherwise.
 * Fail-closed: a client without elicitation support cannot trade unless
 * confirmation is explicitly disabled with TINKOFF_CONFIRM=off.
 */
async function confirmTrade(server: McpServer, message: string): Promise<ToolResult | null> {
  if (!config.confirm) return null;

  if (!server.server.getClientCapabilities()?.elicitation) {
    return fail(
      new Error(
        "Trade rejected: the client does not support MCP elicitation, so the user cannot confirm the order. " +
          "Set TINKOFF_CONFIRM=off to disable confirmation (recommended for sandbox only).",
      ),
    );
  }

  // No form fields: the Accept button itself is the confirmation (one click, no hidden checkbox)
  const res = await server.server.elicitInput(
    {
      message,
      requestedSchema: { type: "object", properties: {} },
    },
    { timeout: CONFIRM_TIMEOUT_MS },
  );

  if (res.action !== "accept") {
    return fail(new Error(`Order not confirmed by user (${res.action})`));
  }
  return null;
}

/**
 * Registered only when TINKOFF_ALLOW_TRADING=true.
 * In production mode these place real orders with real money.
 */
export function registerTradingTools(server: McpServer): void {
  const accountMode = config.sandbox ? "SANDBOX" : "РЕАЛЬНЫЙ СЧЁТ";
  const modeWarning = config.sandbox
    ? "Sandbox mode: orders are simulated."
    : "PRODUCTION MODE: this places a REAL order with REAL money.";
  const confirmNote = config.confirm
    ? "The server itself asks the human to confirm via an MCP elicitation dialog before sending the order."
    : "Confirmation is DISABLED (TINKOFF_CONFIRM=off): the order is sent immediately.";

  server.registerTool(
    "place_order",
    {
      title: "Place Order",
      description: `Place a buy/sell order. ${modeWarning} ${confirmNote} Quantity is in LOTS (lot size — see get_instrument). For limit orders price is per ONE unit, not per lot.`,
      inputSchema: {
        accountId: z.string().describe("Account ID from get_accounts"),
        instrumentId: z.string().describe("Instrument UID from find_instrument or portfolio"),
        direction: z.enum(["buy", "sell"]),
        quantity: z.number().int().positive().describe("Number of LOTS"),
        orderType: z.enum(["market", "limit"]),
        price: z.number().positive().optional().describe("Price per one unit; required for limit orders"),
        priceType: z.enum(["currency", "point"]).default("currency").describe("currency — price in instrument currency; point — in points (% of nominal, for bonds/futures)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ accountId, instrumentId, direction, quantity, orderType, price, priceType }) => {
      try {
        if (orderType === "limit" && price == null) {
          return fail(new Error("price is required for limit orders"));
        }

        const ref = await getInstrumentRef(instrumentId);
        const label = ref ? `${ref.ticker} — ${ref.name}` : instrumentId;
        const rejected = await confirmTrade(
          server,
          `[${accountMode}] ${direction === "buy" ? "ПОКУПКА" : "ПРОДАЖА"}: ${quantity} лот(ов) ${label}, ` +
            `${orderType === "market" ? "по рынку" : `лимит ${price}`}. Подтвердить?`,
        );
        if (rejected) return rejected;

        const r = await getClient().orders.postOrder({
          accountId,
          instrumentId,
          quantity,
          direction:
            direction === "buy" ? OrderDirection.ORDER_DIRECTION_BUY : OrderDirection.ORDER_DIRECTION_SELL,
          orderType: orderType === "market" ? OrderType.ORDER_TYPE_MARKET : OrderType.ORDER_TYPE_LIMIT,
          price: price != null ? toQuotation(price) : undefined,
          priceType: priceType === "point" ? PriceType.PRICE_TYPE_POINT : PriceType.PRICE_TYPE_CURRENCY,
          orderId: randomUUID(),
        });
        return ok({
          orderId: r.orderId,
          status: enumLabel(orderExecutionReportStatusToJSON, r.executionReportStatus, "EXECUTION_REPORT_STATUS_"),
          lotsRequested: r.lotsRequested,
          lotsExecuted: r.lotsExecuted,
          initialOrderPrice: toNumber(r.initialOrderPrice),
          executedOrderPrice: toNumber(r.executedOrderPrice),
          totalOrderAmount: toNumber(r.totalOrderAmount),
          initialCommission: toNumber(r.initialCommission),
          message: r.message,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel Order",
      description: `Cancel an active order by ID (see get_active_orders). ${confirmNote}`,
      inputSchema: {
        accountId: z.string().describe("Account ID from get_accounts"),
        orderId: z.string().describe("Order ID from get_active_orders"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ accountId, orderId }) => {
      try {
        const rejected = await confirmTrade(server, `[${accountMode}] Отменить заявку ${orderId}?`);
        if (rejected) return rejected;

        const r = await getClient().orders.cancelOrder({ accountId, orderId });
        return ok({ cancelledAt: toMsk(r.time) });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
