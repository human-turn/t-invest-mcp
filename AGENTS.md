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

Ожидаемо: 20 tools без флагов (16 read из `read.ts` + 3 архивных из `bulk.ts` +
`get_server_info`); с `TINKOFF_ALLOW_TRADING=true` +2, с `TINKOFF_SANDBOX=true` +3.
Prompts: 15. Реальные проверки — только с sandbox-токеном.

## Структура

| Файл | Назначение |
|---|---|
| `src/index.ts` | Точка входа: регистрация tools/prompts/resources по env-флагам |
| `src/client.ts` | `TTechApiClient` + fail-closed sandbox-прокси (users/operations/orders) + `config` из env |
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
3. **Файлы — только внутри output root** (`TINKOFF_OUTPUT_DIR`/cwd): запись идёт
   ТОЛЬКО через хелперы `output.ts` (`deliver`/`writeRaw`/`createSafeWriter`), не
   сырой `fs`. Они отбивают `../`, симлинк-эскейп родителя и запись ЧЕРЕЗ симлинк
   на финальном компоненте — эти проверки обязаны сохраняться.
4. **Sandbox-прокси fail-closed**: в sandbox-режиме `users`/`operations`/`orders` —
   это `Proxy`, где разрешён только явно подменённый набор методов, остальные
   бросают ошибку (а не уходят молча в прод-счёт). Добавляешь tool, зовущий новый
   метод этих сервисов → добавь sandbox-маппинг в `client.ts`, иначе он упадёт в sandbox.
5. **Токен** — только из env; не логировать, не включать в ответы tools, ресурсы
   и фидбэк-репорты (`get_server_info` намеренно его не отдаёт).
6. Prompt-рецепты **не исполняют сделки** — только планы; исполнение требует явной
   команды пользователя и проходит через п. 2.

## Конвенции кода

- TypeScript strict, без `any`; ESM с расширениями `.js` в импортах (Node16 resolution).
- Деньги/котировки: `Quotation {units, nano}` → `toNumber()` (округление до 9 знаков);
  вычисляемые рубли — до копеек; цены облигаций приходят в % номинала — отдавай
  `priceUnit` рядом с ценой.
- Enum'ы API → строки через `*ToJSON` из SDK + `enumLabel()` (неизвестный код →
  `UNKNOWN_<код>`, информацию не терять). Ручные карты кодов не плодить — есть
  `operationTypeToJSON` и т.п.
- Время → `toMsk()` (отдаёт реальный исторический offset МСК, не всегда `+03:00`;
  невалидная дата → пустая строка).
- Резолв инструмента: `getInstrumentRef()` — best-effort (null и на not-found, и на
  ошибке API; для обогащения); `resolveInstrumentRef()` — строгий (бросает ошибку
  API, null только на genuine not-found; когда ошибка должна всплыть пользователю).
- Каждый tool: тело в `try/catch` → `fail(e)` (хинты по gRPC-кодам уже в `fail`);
  описание на английском, с зависимостями («assetUid ← get_instrument») и единицами.
- Read-tools принимают `outputPath`/`outputFormat` (спред `...outputParams`) и
  отвечают через `deliver(data, rows, out, extras)`; rows = плоский массив для CSV.
- Длинные операции: пагинация/чанкование + `notifyProgress()`; внешние gRPC —
  через `withRateLimitRetry()`. Параллельное обогащение (портфель/заявки/цены) —
  через `mapPool(items, 8, fn)`, не голый `Promise.all` (лимит 200/мин instruments).
- Чанкование свечей: границы чанков общие (`chunk[i].to === chunk[i+1].from`), а
  GetCandles inclusive по `to` → при склейке дедуп по времени обязателен.
- Новые slash-команды: рецепт — функция в `recipes` (один источник правды),
  регистрация отдельно; зонтичные команды собирают те же рецепты через `umbrella()`.
- Известная особенность SDK `@tinkoff/invest-js`: метод `bondBy` (не `getBondBy`);
  незадекларированная зависимость `@bufbuild/protobuf` — уже в package.json, не удалять.
- REST-архивы (`bulk.ts`): параметр `instrumentId` (camelCase!) и ТОЛЬКО UID;
  токен эндпоинту не нужен (шлём для совместимости); HTTP 500 = кривые параметры,
  не токен; 404 = нет данных за год. Запросы — через единый `archiveRequest()`
  (ретрай 429 + фоллбэк хостов tbank↔tinkoff + честная диагностика статусов).

## Релизы

Тег `v*` → GitHub Actions публикует в npm с provenance (`.github/workflows/publish.yml`).
Версию поднимать через `npm version patch|minor` (коммит+тег), затем пуш с тегами.
