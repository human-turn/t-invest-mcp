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
 * Fail-closed sandbox facade for a gRPC service: only the explicitly mapped methods
 * route to their sandbox counterparts; any other method throws instead of silently
 * hitting the PRODUCTION account (which, with a full-access token, would touch real money).
 */
function sandboxService<T extends object>(name: string, mapping: Record<string, unknown>): T {
  return new Proxy(mapping, {
    get(target, prop) {
      if (typeof prop !== "string" || prop in target) return Reflect.get(target, prop);
      return () => {
        throw new Error(
          `${name}.${prop}() is not available in sandbox mode (it would hit the production account). ` +
            `Add a sandbox mapping in client.ts if a sandbox equivalent exists.`,
        );
      };
    },
  }) as T;
}

/**
 * Sandbox mode swaps users/operations/orders for fail-closed sandbox facades.
 * instruments/marketdata are identical in prod and sandbox, so they are left untouched.
 */
function applySandboxProxy(c: TTechApiClient): void {
  const sb = c.sandbox;

  c.users = sandboxService<typeof c.users>("users", {
    getAccounts: (req: unknown, opts: unknown) => sb.getSandboxAccounts(req as never, opts as never),
  });

  c.operations = sandboxService<typeof c.operations>("operations", {
    getPortfolio: (req: unknown, opts: unknown) => sb.getSandboxPortfolio(req as never, opts as never),
    getPositions: (req: unknown, opts: unknown) => sb.getSandboxPositions(req as never, opts as never),
    getOperationsByCursor: (req: unknown, opts: unknown) =>
      sb.getSandboxOperationsByCursor(req as never, opts as never),
  });

  c.orders = sandboxService<typeof c.orders>("orders", {
    getOrders: (req: unknown, opts: unknown) => sb.getSandboxOrders(req as never, opts as never),
    postOrder: (req: unknown, opts: unknown) => sb.postSandboxOrder(req as never, opts as never),
    cancelOrder: (req: unknown, opts: unknown) => sb.cancelSandboxOrder(req as never, opts as never),
  });
}

export function getClient(): TTechApiClient {
  if (client) return client;
  if (!config.token) throw new Error("TINKOFF_API_TOKEN is not set");

  client = new TTechApiClient({ token: config.token });
  if (config.sandbox) applySandboxProxy(client);
  return client;
}
