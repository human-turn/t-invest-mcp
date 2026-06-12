#!/usr/bin/env node
/**
 * Мини-имитация TUI Claude Code для VHS-демо: история сверху, рамка ввода,
 * попап автодополнения slash-команд, диалог подтверждения (elicitation),
 * спиннер, постепенный вывод ответа.
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
const rows = () => process.stdout.rows || 35;

const history = [];
let input = "";
let busy = false;
let spinnerText = null;
let dialog = null; // строки активного диалога подтверждения
let awaitConfirm = false;
let turn = 0;
let spinnerTimer = null;

function styleAnswerLine(l) {
  if (l.startsWith("● ")) return `${BOLD}${l}${RST}`;
  if (l.trimStart().startsWith("⎿")) return `${GRAY}${l}${RST}`;
  return l;
}

function popupRows() {
  if (busy || awaitConfirm || !scenario.commands || !input.startsWith("/")) return [];
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

function dialogRows() {
  if (!dialog) return [];
  const W = Math.min(cols() - 4, 88);
  const out = [`${GRAY}╭${"─".repeat(W)}╮${RST}`];
  for (const l of dialog) {
    const body = ` ${l}`.padEnd(W).slice(0, W);
    let styled = body;
    if (l.includes("❯")) styled = `${BLUE}${BOLD}${body}${RST}`;
    else if (l.startsWith("MCP server")) styled = `${BOLD}${body}${RST}`;
    out.push(`${GRAY}│${RST}${styled}${GRAY}│${RST}`);
  }
  out.push(`${GRAY}╰${"─".repeat(W)}╯${RST}`);
  return out;
}

function render() {
  const popup = popupRows();
  const dlg = dialogRows();
  // видимый хвост истории, чтобы рамка ввода не уезжала за экран
  const chrome = (spinnerText ? 1 : 0) + dlg.length + 1 + 3 + popup.length + 1;
  const visH = history.slice(Math.max(0, history.length - Math.max(0, rows() - chrome - 1)));

  const out = [`${ESC}2J${ESC}H`];
  for (const l of visH) out.push(l + "\n");
  if (spinnerText) out.push(`${spinnerText}\n`);
  for (const d of dlg) out.push(d + "\n");
  out.push("\n");
  const w = cols() - 2;
  out.push(`${GRAY}╭${"─".repeat(w)}╮${RST}\n`);
  const line = ` ❯ ${input}`;
  out.push(`${GRAY}│${RST}${line.padEnd(w).slice(0, w)}${GRAY}│${RST}\n`);
  out.push(`${GRAY}╰${"─".repeat(w)}╯${RST}\n`);
  for (const p of popup) out.push(p + "\n");
  out.push(`${GRAY}  ${scenario.status ?? "t-invest · sandbox"}${RST}`);
  // курсор — в рамку ввода, сразу после набранного текста (как в Claude Code)
  const inputRow = visH.length + (spinnerText ? 1 : 0) + dlg.length + 3;
  out.push(`${ESC}${inputRow};${5 + [...input].length}H`);
  process.stdout.write(out.join(""));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSpinner(ms) {
  let sec = 0;
  spinnerText = `${DIM}✻ Cooking… (0s · esc to interrupt)${RST}`;
  render();
  spinnerTimer = setInterval(() => {
    sec += 1;
    spinnerText = `${DIM}✻ Cooking… (${sec}s · esc to interrupt)${RST}`;
    render();
  }, 1000);
  await sleep(ms);
  clearInterval(spinnerTimer);
  spinnerText = null;
}

async function printLines(lines) {
  for (const l of lines) {
    history.push(styleAnswerLine(l));
    render();
    await sleep(90);
  }
}

async function answer() {
  busy = true;
  history.push(`${DIM}> ${input}${RST}`, "");
  input = "";
  await runSpinner(scenario.thinkMs ?? 1800);

  const t = scenario.turns[turn] ?? {};
  if (t.preAnswer) await printLines(t.preAnswer);
  if (t.confirm) {
    dialog = t.confirm.lines;
    awaitConfirm = true;
    busy = false;
    render();
    return; // ждём Accept
  }
  await printLines(t.answer ?? []);
  history.push("");
  turn += 1;
  busy = false;
  render();
}

async function acceptDialog() {
  dialog = null;
  awaitConfirm = false;
  busy = true;
  render();
  await runSpinner(700);
  const t = scenario.turns[turn] ?? {};
  await printLines(t.answer ?? []);
  history.push("");
  turn += 1;
  busy = false;
  render();
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (b) => {
  const s = b.toString("utf8");
  if (awaitConfirm) {
    if (s.includes("\r") || s.includes("\n") || s.includes("1")) void acceptDialog();
    return;
  }
  if (busy) return;
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
