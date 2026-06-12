import { TTechApiClient } from "@tinkoff/invest-js";

export const config = {
  token: process.env.TINKOFF_API_TOKEN ?? "",
  sandbox: process.env.TINKOFF_SANDBOX === "true",
  allowTrading: process.env.TINKOFF_ALLOW_TRADING === "true",
  /** Human confirmation (MCP elicitation) before each trade; opt out with TINKOFF_CONFIRM=off */
  confirm: process.env.TINKOFF_CONFIRM !== "off",
} as const;

let client: TTechApiClient | undefined;

/**
 * Sandbox mode swaps users/operations/orders methods for their sandbox
 * counterparts (request/response types are fully compatible).
 * instruments/marketdata are identical in prod and sandbox.
 */
function applySandboxProxy(c: TTechApiClient): void {
  const sb = c.sandbox;

  c.users = {
    ...c.users,
    getAccounts: (req, opts) => sb.getSandboxAccounts(req, opts),
  } as typeof c.users;

  c.operations = {
    ...c.operations,
    getPortfolio: (req, opts) => sb.getSandboxPortfolio(req, opts),
    getPositions: (req, opts) => sb.getSandboxPositions(req, opts),
    getOperationsByCursor: (req, opts) => sb.getSandboxOperationsByCursor(req, opts),
  } as typeof c.operations;

  c.orders = {
    ...c.orders,
    getOrders: (req, opts) => sb.getSandboxOrders(req, opts),
    postOrder: (req, opts) => sb.postSandboxOrder(req, opts),
    cancelOrder: (req, opts) => sb.cancelSandboxOrder(req, opts),
  } as typeof c.orders;
}

export function getClient(): TTechApiClient {
  if (client) return client;
  if (!config.token) throw new Error("TINKOFF_API_TOKEN is not set");

  client = new TTechApiClient({ token: config.token });
  if (config.sandbox) applySandboxProxy(client);
  return client;
}
