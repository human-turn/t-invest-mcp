import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";
import { ok, fail, toNumber, toMoneyValue } from "../helpers.js";

/**
 * Sandbox account management. Registered only when TINKOFF_SANDBOX=true.
 * Regular tools (portfolio, orders, operations) already hit the sandbox
 * via the proxy in client.ts; these manage sandbox accounts themselves.
 */
export function registerSandboxTools(server: McpServer): void {
  server.registerTool(
    "sandbox_open_account",
    {
      title: "Open Sandbox Account",
      description: "Open a new sandbox account. Returns accountId for use in other tools.",
      inputSchema: {
        name: z.string().optional().describe("Account display name"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ name }) => {
      try {
        const r = await getClient().sandbox.openSandboxAccount({ name: name ?? "" });
        return ok({ accountId: r.accountId });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sandbox_pay_in",
    {
      title: "Sandbox Pay In",
      description: "Top up a sandbox account with virtual money.",
      inputSchema: {
        accountId: z.string().describe("Sandbox account ID"),
        amount: z.number().positive().describe("Amount to add"),
        currency: z.string().default("rub").describe("Currency code (rub, usd, ...)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ accountId, amount, currency }) => {
      try {
        const r = await getClient().sandbox.sandboxPayIn({
          accountId,
          amount: toMoneyValue(amount, currency),
        });
        return ok({ balance: toNumber(r.balance), currency: r.balance?.currency ?? currency });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sandbox_close_account",
    {
      title: "Close Sandbox Account",
      description: "Close a sandbox account.",
      inputSchema: {
        accountId: z.string().describe("Sandbox account ID"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ accountId }) => {
      try {
        await getClient().sandbox.closeSandboxAccount({ accountId });
        return ok({ closed: true, accountId });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
