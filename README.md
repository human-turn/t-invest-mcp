# t-invest-mcp

MCP-сервер (Model Context Protocol) для [T-Invest API](https://developer.tinkoff.ru/invest/) — Т-Инвестиции (Тинькофф).
Позволяет LLM-агентам (Claude Code, Claude Desktop и др.) работать с брокерским счётом:
портфель, котировки, дивиденды, купоны, фундаментал, прогнозы аналитиков — и, опционально, торговля.

Построен на официальном SDK [`@tinkoff/invest-js`](https://opensource.tbank.ru/invest/invest-js) (gRPC).

## Безопасность по умолчанию

- Без флагов сервер **строго read-only** — торговые tools даже не регистрируются.
- Достаточно **read-only токена** — выпускайте его, если торговля через API не нужна.
- Токен передаётся только через переменную окружения, в коде и логах не хранится.
- Полная поддержка **песочницы** — стратегию можно обкатать на виртуальном счёте.

## Установка

```bash
git clone <repo-url> && cd t-invest-mcp
npm install && npm run build
```

Токен выпускается в [настройках Т-Инвестиций](https://www.tbank.ru/invest/settings/api/)
(«Подтверждение сделок кодом» должно быть выключено; токен живёт 3 месяца с последнего использования).

### Подключение к Claude Code

```bash
claude mcp add t-invest \
  -e TINKOFF_API_TOKEN=<ваш-токен> \
  -- node /path/to/t-invest-mcp/dist/index.js
```

или в `.mcp.json`:

```json
{
  "mcpServers": {
    "t-invest": {
      "command": "node",
      "args": ["/path/to/t-invest-mcp/dist/index.js"],
      "env": {
        "TINKOFF_API_TOKEN": "<ваш-токен>"
      }
    }
  }
}
```

### Подтверждение сделок (ask-правила)

MCP tool annotations (`destructiveHint` и др.) — лишь подсказки: Claude Code не учитывает их
при выдаче разрешений. Если включаете `TINKOFF_ALLOW_TRADING=true`, добавьте в
`.claude/settings.json` проекта `ask`-правила — они имеют приоритет над `allow`
(порядок: deny → ask → allow) и форсируют подтверждение человеком **в любом режиме,
включая `bypassPermissions`**:

```json
{
  "permissions": {
    "allow": ["mcp__t-invest"],
    "ask": [
      "mcp__t-invest__place_order",
      "mcp__t-invest__cancel_order"
    ]
  }
}
```

`allow` на весь сервер убирает промпты по read-only tools, а торговые будут спрашивать
всегда — в том числе защищает от случайного «don't ask again».

## Конфигурация

| Переменная | Значение | Описание |
|---|---|---|
| `TINKOFF_API_TOKEN` | обязательна | Токен T-Invest API (read-only достаточно для базового режима) |
| `TINKOFF_SANDBOX` | `true`/`false` | Песочница: счета/портфель/заявки идут в sandbox, регистрируются `sandbox_*` tools. Нужен sandbox-токен |
| `TINKOFF_ALLOW_TRADING` | `true`/`false` | Регистрирует `place_order`/`cancel_order`. В боевом режиме — реальные деньги! |

## Tools

### Read-only (всегда)

| Tool | Описание |
|---|---|
| `get_accounts` | Список брокерских счетов |
| `get_portfolio` | Портфель: суммы по классам активов, доходность, позиции с тикерами |
| `get_operations` | Операции по счёту (сделки, дивиденды, купоны, комиссии), курсорная пагинация |
| `find_instrument` | Поиск инструмента по тикеру/ISIN/FIGI/названию |
| `get_instrument` | Карточка инструмента (лот, валюта, биржа, assetUid) |
| `get_last_prices` | Последние цены (батч) |
| `get_candles` | Свечи OHLCV (1min…month) |
| `get_order_book` | Стакан заявок |
| `get_dividends` | Дивиденды: история и анонсы |
| `get_bond_coupons` | Купонный календарь облигации |
| `get_accrued_interests` | НКД облигации |
| `get_bond_events` | События облигации: купоны, оферты, погашение |
| `get_asset_fundamentals` | Фундаментал: P/E, EV/EBITDA, ROE, долги, дивдоходность и др. |
| `get_forecasts` | Консенсус-прогнозы и таргеты аналитиков |
| `get_trading_schedules` | Расписание торгов на неделю |
| `get_active_orders` | Активные заявки |

### Торговые (`TINKOFF_ALLOW_TRADING=true`)

| Tool | Описание |
|---|---|
| `place_order` | Выставить заявку (market/limit, в лотах) |
| `cancel_order` | Отменить заявку |

### Песочница (`TINKOFF_SANDBOX=true`)

| Tool | Описание |
|---|---|
| `sandbox_open_account` | Открыть sandbox-счёт |
| `sandbox_pay_in` | Пополнить виртуальными деньгами |
| `sandbox_close_account` | Закрыть sandbox-счёт |

## Рецепт: тестирование стратегии в песочнице

```bash
TINKOFF_API_TOKEN=<sandbox-токен> TINKOFF_SANDBOX=true TINKOFF_ALLOW_TRADING=true \
  node dist/index.js
```

Затем агенту: «открой sandbox-счёт, положи 1 000 000 ₽ и собери модельный портфель 60/40».

## Disclaimer

Не является индивидуальной инвестиционной рекомендацией. Все торговые решения вы
принимаете самостоятельно. В боевом режиме `place_order` оперирует реальными деньгами —
используйте `TINKOFF_ALLOW_TRADING=true` осознанно и держите подтверждение сделок
на стороне агента (human-in-the-loop).

## License

Apache 2.0
