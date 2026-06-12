#!/usr/bin/env node
/**
 * Мини-имитация TUI Claude Code для VHS-демо: история сверху, рамка ввода,
 * попап автодополнения slash-команд, спиннер, постепенный вывод ответа.
 * Запуск: node tui.mjs scenario-main.json  (внутри VHS tape).
 */
import { readFileSync } from "node:fs";

const scenario = JSON.parse(readFileSync(process.argv[2], "utf8"));

const ESC = "\x1b[";
const DIM = `${ESC}38;5;245m`;
const GRAY = `${ESC}38;5;240m`;
const BLUE = `${ESC}38;5;75m`;
const BOLD = `${ESC}1m`;
const RST = `${ESC}0m`;

const cols = () => process.stdout.columns || 100;

const history = [];
let input = "";
let busy = false;
let spinnerText = null;
let turn = 0;
let spinnerTimer = null;

function styleAnswerLine(l) {
  if (l.startsWith("● ")) return `${BOLD}${l}${RST}`;
  if (l.trimStart().startsWith("⎿")) return `${GRAY}${l}${RST}`;
  return l;
}

function popupRows() {
  if (busy || !scenario.commands || !input.startsWith("/")) return [];
  const matched = scenario.commands.filter((c) => c.name.startsWith(input));
  if (!matched.length || (matched.length === 1 && matched[0].name === input)) {
    if (matched.length !== 1) return [];
  }
  const nameW = Math.max(...matched.map((c) => c.name.length)) + 8;
  return matched.slice(0, 12).map((c, i) => {
    const line = `${c.name} (MCP)`.padEnd(nameW) + c.desc;
    const cut = line.slice(0, cols() - 2);
    return i === 0 ? `${BLUE}${cut}${RST}` : `${DIM}${cut}${RST}`;
  });
}

function render() {
  const out = [];
  out.push(`${ESC}2J${ESC}H`); // clear + home
  for (const l of history) out.push(l + "\n");
  if (spinnerText) out.push(`${spinnerText}\n`);
  out.push("\n");
  const w = cols() - 2;
  out.push(`${GRAY}╭${"─".repeat(w)}╮${RST}\n`);
  const line = ` ❯ ${input}`;
  out.push(`${GRAY}│${RST}${line.padEnd(w).slice(0, w)}${GRAY}│${RST}\n`);
  out.push(`${GRAY}╰${"─".repeat(w)}╯${RST}\n`);
  for (const p of popupRows()) out.push(p + "\n");
  out.push(`${GRAY}  ${scenario.status ?? "t-invest · sandbox"}${RST}`);
  // курсор — в рамку ввода, сразу после набранного текста (как в Claude Code)
  const inputRow = history.length + (spinnerText ? 1 : 0) + 3;
  out.push(`${ESC}${inputRow};${5 + [...input].length}H`);
  process.stdout.write(out.join(""));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function answer() {
  busy = true;
  history.push(`${DIM}> ${input}${RST}`, "");
  input = "";
  let sec = 0;
  spinnerText = `${DIM}✻ Cooking… (0s · esc to interrupt)${RST}`;
  render();
  spinnerTimer = setInterval(() => {
    sec += 1;
    spinnerText = `${DIM}✻ Cooking… (${sec}s · esc to interrupt)${RST}`;
    render();
  }, 1000);
  await sleep(scenario.thinkMs ?? 1800);
  clearInterval(spinnerTimer);
  spinnerText = null;

  const lines = scenario.turns[turn]?.answer ?? [];
  for (const l of lines) {
    history.push(styleAnswerLine(l));
    render();
    await sleep(90);
  }
  history.push("");
  turn += 1;
  busy = false;
  render();
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (b) => {
  if (busy) return;
  const s = b.toString("utf8");
  for (const ch of s) {
    if (ch === "\x03") process.exit(0); // ctrl-c
    if (ch === "\r" || ch === "\n") {
      if (input.trim()) void answer();
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      input = input.slice(0, -1);
      continue;
    }
    if (ch >= " ") input += ch;
  }
  if (!busy) render();
});

render();
