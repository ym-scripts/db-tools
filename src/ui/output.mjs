// Terminal output: colours, icons, logging, spinner and formatting helpers.
// Logs go to stderr so stdout stays clean for results (e.g. a backup path).
import { statSync } from 'node:fs';

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = { red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36), dim: paint(2), bold: paint(1) };
export const icon = { pass: c.green('✔'), warn: c.yellow('▲'), fail: c.red('✖'), skip: c.dim('–'), dot: c.dim('·') };

let quiet = false;
export const setQuiet = (q) => { quiet = Boolean(q); };
export const log = (...args) => { if (!quiet) console.error(...args); };
export const warn = (msg) => console.error(`${icon.warn} ${msg}`);

/** An error meant for the user. code 1 = operation failed, 2 = usage/setup error. */
export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
export const usageError = (message) => new CliError(message, 2);

export function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function fmtSecs(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** Runs fn while showing a spinner, plus the growing size of sizeFile if given. */
export async function withSpinner(text, fn, sizeFile) {
  if (!process.stderr.isTTY || quiet) {
    log(`  ${text}…`);
    return fn();
  }
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const t0 = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    let size = '';
    if (sizeFile) { try { size = ` · ${fmtBytes(statSync(sizeFile).size)}`; } catch { /* not created yet */ } }
    process.stderr.write(`\r  ${c.cyan(frames[i++ % frames.length])} ${text} ${c.dim(fmtSecs(Date.now() - t0) + size)}   `);
  }, 120);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K');
  }
}
