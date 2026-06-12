# Безопасное хранение токена

Токен T-Invest API — это доступ к твоему брокерскому счёту. Храни его как пароль.

## Почему `env` в конфиге — слабое звено

Подключение «в лоб» кладёт токен либо прямо в `.mcp.json`, либо в `${TINKOFF_API_TOKEN}`
из shell-профиля (`~/.bashrc`, `~/.zshrc`). И то и другое — **плейнтекст на диске**:
- токен в `.mcp.json` может уехать в git и в логи;
- токен в профиле виден любому процессу через `/proc/<pid>/environ` и в истории команд.

**Принцип:** в конфиге — только *ссылка* на секрет, сам секрет — в зашифрованном
хранилище ОС (Keychain на macOS, Secret Service на Linux, Credential Locker на Windows).
Ниже — кроссплатформенный рецепт через [`keyring`](https://pypi.org/project/keyring/) + wrapper.

## Рецепт: системный keychain + wrapper

### 1. Установи keyring (разово)

```bash
uv tool install keyring      # или: pipx install keyring
```

### 2. Положи токен в хранилище ОС (интерактивно — токен не попадёт в историю)

```bash
keyring set t-invest TINKOFF_API_TOKEN
# keyring спросит значение и сохранит его в зашифрованном vault ОС
```

Выпусти **read-only** токен в [настройках Т-Инвестиций](https://www.tbank.ru/invest/settings/api/) —
для анализа портфеля его достаточно (full-access нужен только если включаешь торговлю).

### 3. Wrapper, который достаёт токен и запускает сервер

**Linux / macOS** — `run-t-invest.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
export TINKOFF_API_TOKEN="$(keyring get t-invest TINKOFF_API_TOKEN)"
exec npx -y t-invest-mcp
# из исходников: exec node /path/to/t-invest-mcp/dist/index.js
```

```bash
chmod +x run-t-invest.sh
```

**Windows** — `run-t-invest.ps1`:

```powershell
$env:TINKOFF_API_TOKEN = (keyring get t-invest TINKOFF_API_TOKEN)
npx -y t-invest-mcp
```

### 4. Подключи сервер через wrapper — токена в конфиге больше нет

```json
{
  "mcpServers": {
    "t-invest": {
      "command": "/path/to/run-t-invest.sh"
    }
  }
}
```

На Windows: `"command": "powershell"`, `"args": ["-File", "C:\\path\\to\\run-t-invest.ps1"]`.

Готово: токена нет ни в `.mcp.json`, ни в shell-профиле — только в keychain ОС.
Дополнительные переменные (`TINKOFF_SANDBOX`, `TINKOFF_ALLOW_TRADING`, `TINKOFF_OUTPUT_DIR`)
ставь в самом wrapper рядом с `export TINKOFF_API_TOKEN`.

## Чек-лист

- **Read-only по умолчанию.** Full-access токен выпускай только когда реально торгуешь.
- **Ротация.** Токен живёт 3 месяца с последнего использования — перевыпускай и обновляй
  в keychain (`keyring set …` поверх старого).
- **Не свети токен.** Не вставляй в чат с AI, в issue, в скриншоты; следи за shell history.
- **Шифрование диска** (FileVault / LUKS / BitLocker) — базовая гигиена под keychain.
