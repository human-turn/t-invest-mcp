import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { completeTicker } from "./catalog.js";

/**
 * Analysis recipes exposed as MCP prompts → slash commands in Claude Code
 * (/mcp__t-invest__portfolio_review etc.). A prompt instructs the model
 * which tools to call and how to present the result; it never trades.
 *
 * Recipe bodies live in `recipes` as plain text builders. Single commands wrap
 * one recipe; umbrella commands (weekly/monthly/quarterly) compose several —
 * one source of truth, no duplication.
 */

const TARGET_FILE_CONVENTION = `Целевые доли и цели портфеля бери из файла portfolio-target.json в корне проекта.
Формат:
{
  "targets": {"shares": 55, "bonds": 30, "etf": 10, "cash": 5},
  "byTicker": {"SBER": 10},
  "goals": [{"name": "FIRE", "targetAmount": 30000000, "targetDate": "2035-01-01",
             "monthlyContribution": 100000, "expectedAnnualReturnPct": 8}]
}
(доли в процентах, классы должны суммироваться к 100; etf — отдельный класс, фонды денежного
рынка типа LQDT допустимо относить к cash — отнесение фиксируй явно; goals — массив, целей
может быть несколько).
Эталон формата доступен как MCP-ресурс t-invest://portfolio-target/example.
Если файла нет — покажи текущую структуру, предложи значения и, после согласования с пользователем, создай файл по эталону.`;

// ─── Recipe bodies ──────────────────────────────────────────────

const recipes = {
  portfolioReview: (account?: string) => `Сделай полный обзор моего портфеля${account ? ` (счёт: ${account})` : " по всем счетам (get_accounts)"}.

1. get_portfolio: общая стоимость, доходность (yieldPercent/yieldRub), структура по классам активов (акции/облигации/фонды/кэш) и по валютам.
2. Концентрация: топ-5 позиций по весу; отметь всё, что выше 15% портфеля. Сгруппируй акции по секторам (get_instrument при необходимости).
3. ${TARGET_FILE_CONVENTION}
4. Сравни факт с целями, покажи отклонения в п.п.
5. Риски: позиции с UNKNOWN-статусом торгов, облигации с офертой/погашением в ближайшие 3 месяца (get_bond_events).

Выведи компактно: сводная таблица, отклонения от целей, 3-5 главных наблюдений. Не предлагай сделки без запроса.`,

  payoutCalendar: (months?: string) => `Построй календарь выплат по моему портфелю на ${months ?? "12"} месяцев вперёд.

1. get_accounts → get_portfolio по каждому счёту.
2. Для каждой облигации: get_bond_coupons (from=сегодня, to=+${months ?? "12"} мес) × количество бумаг (quantity).
3. Для каждой акции: get_dividends — анонсированные выплаты в горизонте × количество.
4. Сведи в таблицу по месяцам: месяц | сумма ₽ | состав (тикер: сумма).
5. Итого: средняя выплата в месяц, минимальный и максимальный месяц, ближайшие 3 выплаты с датами.

Если выплат у позиции нет в горизонте — не включай её. Суммы в рублях, по валютным позициям укажи валюту отдельно.`,

  bondPicker: (amount: string, horizon: string) => `Подбери облигации на сумму ${amount} ₽ с горизонтом ${horizon}.

1. Уточни у меня предпочтения, если не очевидно: ОФЗ / корпоративные / микс; фиксированный купон или флоатер.
2. Кандидатов ищи через find_instrument; для каждого проверь:
   - get_instrument → блок bond: номинал, дата погашения, частота купонов;
   - get_bond_events (type=call): ЕСТЬ ЛИ ОФЕРТА раньше горизонта — если есть, считай доходность к оферте, а не к погашению, и пометь;
   - get_bond_coupons + get_accrued_interests: купоны и НКД;
   - get_last_prices (помни: цена в % номинала — пересчитай в рубли через номинал).
3. Посчитай простую доходность к погашению/оферте: (купоны до даты + (номинал − цена_грязная)) / цена_грязная / лет. Цена грязная = цена в ₽ + НКД.
4. Выведи топ-5..8: тикер | погашение/оферта | цена ₽ | доходность | купон/год | частота | примечания.
5. Предложи распределение суммы по 3-5 выпускам с разными сроками (лесенка). НЕ выставляй заявки.`,

  rebalanceCheck: (threshold?: string) => `Проверь, нужна ли ребалансировка портфеля (порог: ${threshold ?? "5"} п.п.).

1. ${TARGET_FILE_CONVENTION}
2. get_portfolio → фактические доли по классам активов (и по тикерам, если в целях есть byTicker).
3. Посчитай отклонения факт − цель в п.п. Если все в пределах порога — так и скажи, на этом стоп.
4. Если есть превышения: предложи план сделок в ЦЕЛЫХ ЛОТАХ (lot из get_portfolio/get_instrument, цены из get_last_prices; для облигаций цена в % номинала!). Сначала продажи перевеса, потом покупки недовеса; учти освобождающийся кэш.
5. Выведи: таблица отклонений, план сделок (тикер | направление | лоты | ~сумма), остаток кэша. Сделки НЕ исполняй — только план. Исполнение только по моей явной команде через place_order.`,

  positionDeepDive: (ticker: string) => `Сделай глубокий разбор инструмента ${ticker}.

1. find_instrument("${ticker}") → uid; get_instrument → карточка (+ assetUid; для облигаций блок bond).
2. Если есть в моём портфеле (get_portfolio) — моя позиция: количество, средняя, P&L.
3. Акция: get_asset_fundamentals (P/E, ROE, долг, маржа — null значит «неприменимо»), get_forecasts (консенсус и таргеты), get_dividends за 3 года (стабильность выплат).
   Облигация: купоны, НКД, события (оферты!), доходность к погашению.
4. get_candles (day, 1 год): динамика, мин/макс 52 недель, текущая цена относительно диапазона.
5. Вывод: 5-7 тезисов — сильные стороны, риски, что мониторить. Это анализ, не рекомендация.`,

  taxHelper: (year?: string) => {
    const y = year ?? String(new Date().getFullYear());
    return `Посчитай налоговую картину за ${y} год.

1. get_operations (from=${y}-01-01, to=${y}-12-31; для больших периодов используй outputPath и обработай файл скриптом).
2. Сгруппируй: удержанные налоги (типы TAX, DIVIDEND_TAX, BOND_TAX и пр.), комиссии (BROKER_FEE, SERVICE_FEE), дивиденды/купоны получено, реализованный результат по продажам (SELL против BUY по FIFO — приближённо).
3. ЛДВ: по операциям найди позиции из текущего портфеля, купленные 3+ года назад и непрерывно держащиеся — кандидаты на льготу долгосрочного владения при продаже.
4. Выведи: таблица «удержано налогов по типам», комиссии итого, доход по выплатам, список ЛДВ-кандидатов с датами покупки.
ВАЖНО: это прикидка для ориентира, не налоговая консультация; точные цифры — в справке брокера.`;
  },

  divScreener: (minYield?: string) => `Найди дивидендные акции MOEX с доходностью от ${minYield ?? "6"}%.

1. Возьми 15-20 ликвидных дивидендных кандидатов MOEX (голубые фишки + известные дивидендные истории; find_instrument по тикерам).
2. Для каждого: get_instrument → assetUid; get_asset_fundamentals → dividendYieldDailyTtm / forwardAnnualDividendYield; get_dividends за 3 года → платил ли каждый год, рос ли дивиденд.
3. Отфильтруй: доходность ≥ ${minYield ?? "6"}%, выплаты не прерывались 3 года.
4. Таблица: тикер | доходность TTM | форвардная | 3 года подряд? | рост? | P/E | примечание (риски отсечки/разовости).
5. Отметь, что из этого уже есть в моём портфеле (get_portfolio). Это скрининг, не рекомендация.`,

  feedback: (issue?: string) => `Сформируй фидбэк-репорт для разработчиков t-invest-mcp${issue ? ` по проблеме: «${issue}»` : ""}.

1. Диагностика: вызови get_server_info (версия, режимы, окружение) и перечисли видимые тебе tools/команды сервера t-invest.
2. Восстанови картину из текущего диалога: какие tools вызывались и с какими аргументами, ТОЧНЫЕ тексты ошибок и ответов (цитируй дословно), что ожидалось и что получилось. Если проблема не из этого диалога — расспроси пользователя и попробуй воспроизвести (ТОЛЬКО read-only вызовами, никаких сделок).
3. Собери markdown-репорт:
   # Feedback: <краткая тема>
   Дата · версия сервера и режимы (из get_server_info) · клиент (Claude Code/Desktop) и ОС
   ## Сводка — таблица: блок | статус (✅/⚠️/❌)
   ## Проблема — шаги воспроизведения, ожидание vs реальность, точные тексты ошибок
   ## Контекст — фрагменты вызовов/ответов, относящиеся к делу
4. ПРИВАТНОСТЬ (обязательный шаг): токенов в файле быть не должно ни в каком виде. Покажи пользователю готовый текст репорта и спроси, замаскировать ли accountId, суммы и состав портфеля — примени его выбор.
5. Сохрани файл в feedback/FEEDBACK-<YYYY-MM-DD>-<краткий-slug>.md и спроси, как передать: создать GitHub issue (gh issue create --repo human-turn/t-invest-mcp --title "<тема>" --body-file <файл>) или пользователь отправит файл сам.`,

  investCash: (amount: string) => `Пришло пополнение — распредели его докупками, приближая портфель к целевым долям (БЕЗ продаж).

0. Сумма из аргумента команды: «${amount}». ВНИМАНИЕ: аргументы режутся по пробелам — если
   значение выглядит обрезанным (например «10» вместо «10 000») или это не число, СНАЧАЛА
   уточни полную сумму у пользователя и работай с подтверждённой.
1. ${TARGET_FILE_CONVENTION}
2. get_portfolio → текущие доли; посчитай недовес каждого класса/тикера относительно целей в рублях.
3. Распредели подтверждённую сумму по недовешенным позициям пропорционально недовесу, в ЦЕЛЫХ ЛОТАХ (lot и цены из get_instrument/get_last_prices; облигации — цена в % номинала + НКД!).
4. Алгоритм жадный: покупай лоты самого недовешенного, пока сумма не исчерпана; остаток < минимального лота — оставь кэшем.
5. Выведи план: тикер | лоты | ~сумма | доля после покупки, и остаток. Сделки НЕ исполняй — только план; исполнение по моей явной команде.`,

  monthlyReport: (month?: string) => `Подбей итоги месяца${month ? ` (${month})` : " (прошлый календарный месяц)"} по портфелю — с честной доходностью.

1. get_accounts → по каждому счёту get_portfolio (текущая стоимость).
2. Выгрузи операции: get_operations c outputPath="reports/operations_full.csv" (вся доступная история — нужна для XIRR) и отдельно за отчётный месяц.
3. Напиши и запусти скрипт (python через uv run, либо node) по файлу: XIRR денежного потока (INPUT/OUTPUT как потоки, текущая стоимость портфеля как финальный поток) — это честная годовая доходность с учётом пополнений.
4. За месяц: изменение стоимости, пополнения/выводы, выплаты (DIVIDEND/COUPON), комиссии и налоги (BROKER_FEE/TAX*), топ-3 выросших и упавших позиции (get_candles по позициям за месяц).
5. Выведи: сводка месяца, XIRR с начала инвестирования, динамика к прошлому месяцу. Файл отчёта сохрани в reports/monthly_<год-месяц>.md.`,

  weeklyDigest: () => `Сделай недельный дайджест портфеля.

1. get_portfolio → позиции; get_candles (interval=day, последние 7 дней) по каждой позиции → изменение за неделю в % и ₽ с учётом количества.
2. Портфель целиком: суммарное изменение за неделю.
3. Топ-3 выросших и топ-3 упавших; для них поищи причину: get_forecasts (менялся ли консенсус), get_dividends/get_bond_events (отсечки/оферты на неделе), и если доступен поисковый инструмент (exa/web search) — 1-2 свежие новости по эмитенту.
4. Ближайшая неделя: отсечки, купоны, оферты по моим позициям; расписание (нерабочие дни — get_trading_schedules).
5. Выведи компактный дайджест: движение портфеля, таблица топ-движений с причинами, события недели. Без рекомендаций.`,

  fireProgress: () => `Покажи прогресс к финансовым целям.

1. ${TARGET_FILE_CONVENTION}
   Целей в goals может быть несколько — отчитайся по КАЖДОЙ.
2. get_accounts → суммарная текущая стоимость портфелей (get_portfolio).
3. Фактический темп пополнений: get_operations за последние 12 месяцев → сумма INPUT − OUTPUT, среднее в месяц; сравни с monthlyContribution из цели.
4. Для каждой цели посчитай (скриптом, не в уме): при текущем капитале, фактическом темпе пополнений и expectedAnnualReturnPct — в каком году будет достигнут targetAmount; успеваем ли к targetDate; какой нужен ежемесячный взнос, чтобы успеть точно в срок.
5. Выведи по каждой цели: прогресс-бар (например, ████░░ 62%), капитал/цель, прогнозный год достижения, вердикт «успеваем/нет», необходимая корректировка взноса. Допущения укажи явно.`,
};

// ─── Umbrella composition ───────────────────────────────────────

function umbrella(intro: string, sections: Array<{ title: string; body: string }>): string {
  return [
    `${intro}\n\nВыполни последовательно разделы ниже и сведи всё в ОДИН компактный отчёт с заголовками; промежуточные таблицы не дублируй.`,
    ...sections.map((s, i) => `## Раздел ${i + 1}: ${s.title}\n\n${s.body}`),
  ].join("\n\n---\n\n");
}

function text(s: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text: s } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "portfolio_review",
    {
      title: "Обзор портфеля",
      description: "Полный обзор: структура, концентрация, доходность, сравнение с целевыми долями",
      argsSchema: { account: z.string().optional().describe("Имя или ID счёта (по умолчанию — все счета)") },
    },
    ({ account }) => text(recipes.portfolioReview(account)),
  );

  server.registerPrompt(
    "payout_calendar",
    {
      title: "Календарь выплат",
      description: "Купоны и дивиденды по портфелю на N месяцев вперёд, средняя выплата в месяц",
      argsSchema: { months: z.string().optional().describe("Горизонт в месяцах (по умолчанию 12)") },
    },
    ({ months }) => text(recipes.payoutCalendar(months)),
  );

  server.registerPrompt(
    "bond_picker",
    {
      title: "Подбор облигаций",
      description: "Подбор облигаций под сумму и горизонт: доходность, оферты, НКД",
      argsSchema: {
        amount: z.string().describe("Сумма в рублях, например 500000"),
        horizon: z.string().describe("Горизонт, например «3 года» или «до 2029»"),
      },
    },
    ({ amount, horizon }) => text(recipes.bondPicker(amount, horizon)),
  );

  server.registerPrompt(
    "rebalance_check",
    {
      title: "Проверка ребалансировки",
      description: "Дрейф от целевых долей и план сделок в лотах (без исполнения)",
      argsSchema: { threshold: z.string().optional().describe("Порог отклонения в п.п., по умолчанию 5") },
    },
    ({ threshold }) => text(recipes.rebalanceCheck(threshold)),
  );

  server.registerPrompt(
    "position_deep_dive",
    {
      title: "Разбор позиции",
      description: "Глубокий разбор одного инструмента: фундаментал, прогнозы, выплаты, динамика",
      argsSchema: { ticker: completable(z.string().describe("Тикер, например SBER"), completeTicker) },
    },
    ({ ticker }) => text(recipes.positionDeepDive(ticker)),
  );

  server.registerPrompt(
    "tax_helper",
    {
      title: "Налоговый помощник",
      description: "Налоги за год из операций + кандидаты на ЛДВ (3+ года)",
      argsSchema: { year: z.string().optional().describe("Год, по умолчанию текущий") },
    },
    ({ year }) => text(recipes.taxHelper(year)),
  );

  server.registerPrompt(
    "div_screener",
    {
      title: "Дивидендный скрининг",
      description: "Скрининг дивидендных акций MOEX: стабильность и форвардная доходность",
      argsSchema: { min_yield: z.string().optional().describe("Минимальная дивдоходность в %, по умолчанию 6") },
    },
    ({ min_yield }) => text(recipes.divScreener(min_yield)),
  );

  server.registerPrompt(
    "invest_cash",
    {
      title: "Распределить пополнение",
      description: "DCA-докупка: распределить свободный кэш к целевым долям, без продаж",
      argsSchema: { amount: z.string().describe("Сумма в рублях БЕЗ пробелов и валюты, например 100000") },
    },
    ({ amount }) => text(recipes.investCash(amount)),
  );

  server.registerPrompt(
    "monthly_report",
    {
      title: "Итоги месяца",
      description: "Месячный отчёт: честный XIRR, выплаты, комиссии, топ-движения",
      argsSchema: { month: z.string().optional().describe("Месяц YYYY-MM (по умолчанию прошлый)") },
    },
    ({ month }) => text(recipes.monthlyReport(month)),
  );

  server.registerPrompt(
    "weekly_digest",
    {
      title: "Недельный дайджест",
      description: "Что выросло/упало за неделю и почему + события ближайшей недели",
      argsSchema: {},
    },
    () => text(recipes.weeklyDigest()),
  );

  server.registerPrompt(
    "fire_progress",
    {
      title: "Прогресс к целям",
      description: "Прогресс к финансовым целям (FIRE): успеваем ли, какой нужен взнос",
      argsSchema: {},
    },
    () => text(recipes.fireProgress()),
  );

  server.registerPrompt(
    "feedback",
    {
      title: "Фидбэк разработчикам",
      description:
        "Сформировать репорт о проблеме: диагностика сервера, шаги воспроизведения, точные ошибки → feedback/*.md (+ опционально GitHub issue)",
      argsSchema: { issue: z.string().optional().describe("Краткое описание проблемы") },
    },
    ({ issue }) => text(recipes.feedback(issue)),
  );

  // ─── Umbrella commands: composed from the same recipes ───

  server.registerPrompt(
    "weekly",
    {
      title: "Недельный ритуал",
      description: "Дайджест недели + распределение пополнения (если указана сумма)",
      argsSchema: {
        amount: z.string().optional().describe("Сумма ₽ без пробелов, напр. 100000 (без неё раздел докупки пропускается)"),
      },
    },
    ({ amount }) =>
      text(
        umbrella("Недельный ритуал по портфелю.", [
          { title: "Дайджест недели", body: recipes.weeklyDigest() },
          ...(amount ? [{ title: "Распределение пополнения", body: recipes.investCash(amount) }] : []),
        ]),
      ),
  );

  server.registerPrompt(
    "monthly",
    {
      title: "Месячный ритуал",
      description: "Итоги месяца (XIRR) + календарь выплат + прогресс к целям",
      argsSchema: {},
    },
    () =>
      text(
        umbrella("Месячный ритуал по портфелю.", [
          { title: "Итоги месяца", body: recipes.monthlyReport() },
          { title: "Календарь выплат", body: recipes.payoutCalendar() },
          { title: "Прогресс к целям", body: recipes.fireProgress() },
        ]),
      ),
  );

  server.registerPrompt(
    "quarterly",
    {
      title: "Квартальный ритуал",
      description: "Обзор портфеля + проверка ребалансировки",
      argsSchema: {},
    },
    () =>
      text(
        umbrella("Квартальный ритуал по портфелю.", [
          { title: "Обзор портфеля", body: recipes.portfolioReview() },
          { title: "Проверка ребалансировки", body: recipes.rebalanceCheck() },
        ]),
      ),
  );
}
