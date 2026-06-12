import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OrderDirection, OrderType, PriceType } from "@tinkoff/invest-js";
import { getClient, config } from "../client.js";
import { ok, fail, toNumber, toQuotation, toMsk } from "../helpers.js";

/**
 * Registered only when TINKOFF_ALLOW_TRADING=true.
 * In production mode these place real orders with real money.
 */
export function registerTradingTools(server: McpServer): void {
  const modeWarning = config.sandbox
    ? "Sandbox mode: orders are simulated."
    : "PRODUCTION MODE: this places a REAL order with REAL money. Always confirm with the user before calling.";

  server.registerTool(
    "place_order",
    {
      title: "Place Order",
      description: `Place a buy/sell order. ${modeWarning} Quantity is in LOTS (lot size — see get_instrument). For limit orders price is per ONE unit, not per lot.`,
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
          status: r.executionReportStatus,
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
      description: "Cancel an active order by ID (see get_active_orders).",
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
        const r = await getClient().orders.cancelOrder({ accountId, orderId });
        return ok({ cancelledAt: toMsk(r.time) });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
