import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../client.js";
import { ok, fail } from "../helpers.js";
import { outputRoot } from "../output.js";
import { VERSION } from "../version.js";
import { getArchiveHost } from "./bulk.js";

export function registerInfoTools(server: McpServer): void {
  server.registerTool(
    "get_server_info",
    {
      title: "Get Server Info",
      description:
        "Server diagnostics for support/feedback reports: version, runtime, mode flags (sandbox/trading/confirmation), output root, selected archive host. No broker API calls, never includes the token.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok({
          name: "t-invest-mcp-server",
          version: VERSION,
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          mode: config.sandbox ? "sandbox" : "production",
          tradingEnabled: config.allowTrading,
          tradeConfirmation: config.confirm,
          outputRoot: outputRoot(),
          archiveHost: getArchiveHost() ?? "not contacted yet",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
