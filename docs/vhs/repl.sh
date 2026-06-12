#!/usr/bin/env bash
# Фейковый REPL для VHS-демо: на каждую введённую строку печатает следующий
# заготовленный ответ (файлы-аргументы) с эффектом построчного вывода.
# Данные в ответах — песочница, не реальный портфель.
DIR="$(cd "$(dirname "$0")" && pwd)"
files=("$@")
i=0
while IFS= read -r -e -p "❯ " _line; do
  f="${files[$i]}"
  [ -z "$f" ] && break
  echo
  while IFS= read -r out; do
    printf '%s\n' "$out"
    sleep 0.05
  done < "$DIR/$f"
  echo
  i=$((i + 1))
done
