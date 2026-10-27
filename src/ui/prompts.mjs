// Minimal interactive prompts (text, hidden, confirm, select) with no dependencies.
import readline from 'node:readline';
import { c, CliError, usageError } from './output.mjs';

const out = process.stderr;

export const isInteractive = () => Boolean(process.stdin.isTTY && out.isTTY);

function requireTty(what) {
  if (!isInteractive()) throw usageError(`${what} is required (no terminal to ask on).`);
}

const cancelled = () => new CliError('Cancelled.', 130);

export function input({ message, initial = '', validate }) {
  requireTty(message);
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
    const hint = initial ? c.dim(` (${initial})`) : '';
    const askOnce = () => rl.question(`${c.bold('?')} ${message}${hint} `, (answer) => {
      const value = answer.trim() || initial;
      const problem = validate?.(value);
      if (problem) { out.write(`  ${c.red(problem)}\n`); return askOnce(); }
      rl.close();
      resolve(value);
    });
    rl.on('SIGINT', () => { rl.close(); out.write('\n'); reject(cancelled()); });
    askOnce();
  });
}

/** Reads a line without echoing it (shows • per character). */
export function password({ message, validate }) {
  requireTty(message);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buf = '';
    out.write(`${c.bold('?')} ${message} `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (err) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      out.write('\n');
      if (err) return reject(err);
      const value = buf.trim();
      const problem = validate?.(value);
      if (problem) {
        out.write(`  ${c.red(problem)}\n`);
        return resolve(password({ message, validate }));
      }
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(cancelled());
        if (ch === '\u007f' || ch === '\b') {
          if (buf) { buf = buf.slice(0, -1); out.write('\b \b'); }
        } else if (ch >= ' ') {
          buf += ch;
          out.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm({ message, initial = false }) {
  const answer = await input({ message: `${message} ${c.dim(initial ? '[Y/n]' : '[y/N]')}` });
  return answer ? /^y(es)?$/i.test(answer) : initial;
}

/** Arrow-key list. choices: [{ value, label, hint? }] */
export function select({ message, choices, initial = 0 }) {
  requireTty(message);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let i = Math.max(0, initial);
    const width = Math.max(...choices.map((ch) => ch.label.length));
    const draw = (first) => {
      if (!first) out.write(`\x1b[${choices.length}A`);
      choices.forEach((ch, j) => {
        const text = ch.hint ? ch.label.padEnd(width) : ch.label;
        const line = j === i ? c.cyan(`❯ ${text}`) : `  ${text}`;
        out.write(`\x1b[2K${line}${ch.hint ? c.dim(`  ${ch.hint}`) : ''}\n`);
      });
    };
    const done = (err) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      out.write(`\x1b[${choices.length}A\x1b[J`);
      if (err) return reject(err);
      out.write(`  ${c.dim('→')} ${choices[i].label}\n`);
      resolve(choices[i].value);
    };
    const onKey = (_, key = {}) => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') return done(cancelled());
      if (key.name === 'up' || key.name === 'k') i = (i - 1 + choices.length) % choices.length;
      else if (key.name === 'down' || key.name === 'j') i = (i + 1) % choices.length;
      else if (key.name === 'return') return done();
      else return;
      draw(false);
    };
    out.write(`${c.bold('?')} ${message} ${c.dim('(↑/↓, enter)')}\n`);
    draw(true);
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
  });
}
