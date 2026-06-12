import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Reference artifacts exposed as MCP resources (readable by both humans and agents) */

const PORTFOLIO_TARGET_EXAMPLE = {
  $comment:
    "Эталон portfolio-target.json: скопируйте в корень проекта и поправьте значения. targets/byTicker — проценты, классы targets должны суммироваться к 100 (etf — отдельный класс; фонды денежного рынка типа LQDT при желании относите к cash, фиксируя это в byTicker). goals — массив, целей может быть несколько.",
  targets: { shares: 55, bonds: 30, etf: 10, cash: 5 },
  byTicker: { SBER: 10 },
  goals: [
    {
      name: "FIRE",
      targetAmount: 30_000_000,
      targetDate: "2035-01-01",
      monthlyContribution: 100_000,
      expectedAnnualReturnPct: 8,
    },
    {
      name: "Образование детям",
      targetAmount: 5_000_000,
      targetDate: "2031-09-01",
      monthlyContribution: 25_000,
      expectedAnnualReturnPct: 8,
    },
  ],
};

export function registerResources(server: McpServer): void {
  server.registerResource(
    "portfolio-target-example",
    "t-invest://portfolio-target/example",
    {
      title: "portfolio-target.json — эталон",
      description:
        "Образец файла целевых долей и финансовых целей для slash-команд (rebalance_check, fire_progress, invest_cash, зонтичные ритуалы). Скопируйте в корень проекта как portfolio-target.json.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(PORTFOLIO_TARGET_EXAMPLE, null, 2),
        },
      ],
    }),
  );
}
