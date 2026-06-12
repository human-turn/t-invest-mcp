# AGENTS.md — инструкции для AI-агентов

MCP-сервер (TypeScript, stdio) для T-Invest API (Т-Инвестиции). Агент, работающий
с этим репо, обязан соблюдать инварианты безопасности — они важнее любых фич.

## Сборка и проверка

```bash
npm install
npm run build        # tsc, strict mode — должен проходить без ошибок
npm run dev          # запуск из исходников (tsx)
```

Unit-тестов пока нет. Смоук-тест — JSON-RPC по stdio (без реального токена сервер
стартует и отдаёт списки):

```bash
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2) \
  | TINKOFF_API_TOKEN=fake node dist/index.js
```

Ожидаемо: 19 read-tools (в т.ч. `get_server_info`, `download_history_archive`);
с `TINKOFF_ALLOW_TRADING=true` +2, с `TINKOFF_SANDBOX=true` +3. Prompts: 15.
Реальные проверки — только с sandbox-токеном.

## Структура

| Файл | Назначение |
|---|---|
| `src/index.ts` | Точка входа: регистрация tools/prompts/resources по env-флагам |
| `src/client.ts` | `TTechApiClient` + sandbox-прокси (подмена users/operations/orders) + `config` из env |
| `src/helpers.ts` | Quotation→number, toMsk, enumLabel, ретраи rate-limit, MCP progress, chunking |
| `src/output.ts` | Файловые выгрузки `outputPath`: path-guard, CSV, summary |
| `src/instruments-cache.ts` | Мемо-кэш uid→тикер/имя/лот (обогащение ответов) |
| `src/catalog.ts` | Ленивый каталог тикеров для автодополнения prompt-аргументов |
| `src/prompts.ts` | Рецепты slash-команд: константы `recipes` + зонтичные композиции |
| `src/resources.ts` | MCP-ресурсы (эталон portfolio-target.json) |
| `src/tools/read.ts` | 16 read-tools |
| `src/tools/bulk.ts` | REST-архивы минутных свечей (фоллбэк хостов, троттлинг 30/мин) |
| `src/tools/trading.ts` | place/cancel order + elicitation-подтверждение |
| `src/tools/sandbox.ts` | Управление sandbox-счетами |
| `src/tools/info.ts` | Диагностика для фидбэков |

## Инварианты безопасности (НЕ ослаблять)

1. **Read-only по умолчанию**: торговые tools регистрируются только при
   `TINKOFF_ALLOW_TRADING=true`; sandbox-tools — только при `TINKOFF_SANDBOX=true`.
2. **Подтверждение сделок**: перед `postOrder`/`cancelOrder` — elicitation-диалог
   человеку; клиент без поддержки elicitation получает отказ (fail-closed).
   Отключение только явным `TINKOFF_CONFIRM=off`.
3. **Файлы — только внутри output root** (`TINKOFF_OUTPUT_DIR`/cwd): realpath-проверка
   от `../` и симлинк-эскейпов в `output.ts` обязана сохраняться.
4. **Токен** — только из env; не логировать, не включать в ответы tools, ресурсы
   и фидбэк-репорты (`get_server_info` намеренно его не отдаёт).
5. Prompt-рецепты **не исполняют сделки** — только планы; исполнение требует явной
   команды пользователя и проходит через п. 2.

## Конвенции кода

- TypeScript strict, без `any`; ESM с расширениями `.js` в импортах (Node16 resolution).
- Деньги/котировки: `Quotation {units, nano}` → `toNumber()` (округление до 9 знаков);
  вычисляемые рубли — до копеек; цены облигаций приходят в % номинала — отдавай
  `priceUnit` рядом с ценой.
- Enum'ы API → строки через `*ToJSON` из SDK + `enumLabel()` (неизвестный код →
  `UNKNOWN_<код>`, информацию не терять).
- Время → `toMsk()` с явным offset `+03:00`.
- Каждый tool: тело в `try/catch` → `fail(e)` (хинты по gRPC-кодам уже в `fail`);
  описание на английском, с зависимостями («assetUid ← get_instrument») и единицами.
- Read-tools принимают `outputPath`/`outputFormat` (спред `...outputParams`) и
  отвечают через `deliver(data, rows, out, extras)`; rows = плоский массив для CSV.
- Длинные операции: пагинация/чанкование + `notifyProgress()`; внешние вызовы —
  через `withRateLimitRetry()`.
- Новые slash-команды: рецепт — функция в `recipes` (один источник правды),
  регистрация отдельно; зонтичные команды собирают те же рецепты через `umbrella()`.
- Известная особенность SDK `@tinkoff/invest-js`: метод `bondBy` (не `getBondBy`);
  незадекларированная зависимость `@bufbuild/protobuf` — уже в package.json, не удалять.

## Релизы

Тег `v*` → GitHub Actions публикует в npm с provenance (`.github/workflows/publish.yml`).
Версию поднимать через `npm version patch|minor` (коммит+тег), затем пуш с тегами.
