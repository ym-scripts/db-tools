// Running client tools (pg_dump, mysqldump, …), with optional gzip on either end.
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { CliError } from '../ui/output.mjs';

/** True when `cmd --version` runs. */
export function hasCommand(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

export function commandVersion(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return r.error || r.status !== 0 ? null : r.stdout.trim();
}

function spawnTool(cmd, args, env, stdio) {
  const child = spawn(cmd, args, { env: env ?? process.env, stdio });
  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new CliError(`${cmd} not found on PATH`, 2) : e));
    child.on('close', (code) => resolve(code));
  });
  return { child, exited, out: () => stdout, err: () => stderr, collect: () => child.stdout?.on('data', (d) => { stdout += d; }) };
}

/** Runs a command and collects its output. */
export async function run(cmd, args, { env } = {}) {
  const t = spawnTool(cmd, args, env, ['ignore', 'pipe', 'pipe']);
  t.collect();
  const code = await t.exited;
  return { code, stdout: t.out(), stderr: t.err() };
}

/** Runs a command with the terminal attached (interactive shells). */
export async function runInteractive(cmd, args, { env } = {}) {
  return spawnTool(cmd, args, env, 'inherit').exited;
}

/** Streams a command's stdout into a file, gzipping it on the way if asked. */
export async function runToFile(cmd, args, { env, file, gzip = false }) {
  const t = spawnTool(cmd, args, env, ['ignore', 'pipe', 'pipe']);
  const streams = [t.child.stdout, ...(gzip ? [createGzip()] : []), createWriteStream(file, { mode: 0o600 })];
  const [code] = await Promise.all([t.exited, pipeline(...streams)]);
  return { code, stderr: t.err() };
}

/** Streams a file into a command's stdin, gunzipping it on the way if asked. */
export async function runFromFile(cmd, args, { env, file, gunzip = false }) {
  const t = spawnTool(cmd, args, env, ['pipe', 'pipe', 'pipe']);
  t.collect();
  const feed = pipeline(createReadStream(file), ...(gunzip ? [createGunzip()] : []), t.child.stdin)
    .catch((e) => { if (e.code !== 'EPIPE') throw e; });   // the tool may exit early on an error
  const [code] = await Promise.all([t.exited, feed]);
  return { code, stdout: t.out(), stderr: t.err() };
}

/** First line of a tool's error output, for messages. */
export const firstLine = (s, fallback = 'unknown error') => (s || '').trim().split('\n')[0] || fallback;
