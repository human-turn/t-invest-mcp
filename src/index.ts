#!/usr/bin/env node
/**
 * MCP server for T-Invest API (Tinkoff Investments).
 *
 * Env:
 *   TINKOFF_API_TOKEN    — required, token from https://www.tbank.ru/invest/settings/api/
 *   TINKOFF_SANDBOX      — "true" to route accounts/portfolio/orders to the sandbox
 *   TINKOFF_ALLOW_TRADING — "true" to register place_order/cancel_order
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./client.js";
import { registerReadTools } from "./tools/read.js";
import { registerTradingTools } from "./tools/trading.js";
import { registerSandboxTools } from "./tools/sandbox.js";

if (!config.token) {
  console.error("ERROR: TINKOFF_API_TOKEN environment variable is required");
  process.exit(1);
}

const server = new McpServer({ name: "t-invest-mcp-server", version: "0.1.0" });

registerReadTools(server);
if (config.allowTrading) registerTradingTools(server);
if (config.sandbox) registerSandboxTools(server);

await server.connect(new StdioServerTransport());
console.error(
  `t-invest-mcp: mode=${config.sandbox ? "sandbox" : "production"}, trading=${config.allowTrading ? "ENABLED" : "disabled"}`,
);
