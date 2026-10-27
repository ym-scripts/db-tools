// Option specs and helpers shared by several commands.
import { parseDbUrl, SUPPORTED, label } from '../lib/url.mjs';
import { engineFor } from '../engines/index.mjs';
import { isInteractive, password, input } from '../ui/prompts.mjs';
import { usageError, log, c } from '../ui/output.mjs';

export const opt = {
  url: { short: 'u', type: 'string', arg: 'URL', env: 'DATABASE_URL', desc: 'Database URL (postgres://… or mysql://…)' },
  dir: { short: 'd', type: 'string', arg: 'DIR', env: 'BACKUP_DIR', default: './backups', desc: 'Local backup folder' },
  keep: { short: 'k', type: 'number', arg: 'N', env: 'BACKUP_KEEP', default: 7, desc: 'Keep the newest N backups, 0 = all' },
  name: { type: 'string', arg: 'NAME', desc: 'Backup name prefix (default: database name)' },
  s3: { type: 'string', arg: 'URI', env: 'BACKUP_S3', desc: 'Also use s3://bucket/prefix' },
  s3Endpoint: { type: 'string', arg: 'URL', env: 'BACKUP_S3_ENDPOINT', desc: 'S3-compatible endpoint (R2, B2, MinIO)' },
  yes: { short: 'y', type: 'boolean', desc: "Don't ask for confirmation" },
  quiet: { short: 'q', type: 'boolean', desc: 'Only print errors and results' },
  help: { short: 'h', type: 'boolean', desc: 'Show this help' },
};

const validUrl = (v) => {
  if (!v) return 'Required';
  try { parseDbUrl(v); return null; } catch (e) { return e.message; }
};

/**
 * Turns a URL option into a connection. Missing → asks (hidden input) when there's a
 * terminal, otherwise a usage error.
 */
export async function connection(value, { what = 'Database URL', flag = '--url' } = {}) {
  let raw = value;
  if (!raw) {
    if (!isInteractive()) throw usageError(`${what} is required. Pass ${flag}${flag === '--url' ? ' or set DATABASE_URL' : ''}.`);
    raw = await password({ message: `${what} ${c.dim(`(${SUPPORTED})`)}:`, validate: validUrl });
  }
  const conn = parseDbUrl(raw, what);
  return { conn, engine: engineFor(conn) };
}

/** Asks for an optional value only in guided (menu) mode. */
export async function guided(ctx, current, prompt) {
  return ctx.guided ? input({ ...prompt, initial: String(current ?? '') }) : current;
}

export function describe(conn, engine) {
  log(`  ${c.dim(engine.name)} ${c.bold(label(conn))}`);
}
