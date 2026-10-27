// Backup files: naming, listing, retention and locking, locally and on S3.
import { mkdirSync, rmdirSync, existsSync, rmSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run, hasCommand, firstLine } from './exec.mjs';
import { onExit } from './cleanup.mjs';
import { CliError, usageError } from '../ui/output.mjs';

export const BACKUP_RE = /^(.+)_(\d{8}-\d{6})\.(dump|sql\.gz)$/;

/** shop_20261027-020000.dump (UTC) */
export function backupFileName(name, ext, date = new Date()) {
  const ts = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${name}_${ts}.${ext}`;
}

export function parseBackupName(file) {
  const m = BACKUP_RE.exec(file);
  return m ? { name: m[1], ts: m[2], ext: m[3] } : null;
}

const byTimestamp = (a, b) => a.ts.localeCompare(b.ts) || a.file.localeCompare(b.file);

/** Local backups, oldest first. name = null lists every database. */
export async function listLocal(dir, name = null) {
  if (!existsSync(dir)) return [];
  const items = [];
  for (const file of await readdir(dir)) {
    const p = parseBackupName(file);
    if (!p || (name && p.name !== name)) continue;
    const path = join(dir, file);
    items.push({ ...p, file, path, size: (await stat(path)).size, where: 'local' });
  }
  return items.sort(byTimestamp);
}

/** The items to delete so that only the newest `keep` remain (keep 0 = keep all). */
export function toPrune(items, keep) {
  if (!keep || items.length <= keep) return [];
  return [...items].sort(byTimestamp).slice(0, items.length - keep);
}

export function removeLocal(path) {
  rmSync(path, { force: true });
  rmSync(`${path}.sha256`, { force: true });
}

/** Directory lock so overlapping runs (e.g. cron) don't collide. Released on exit. */
export function acquireLock(dir, name) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, `.${name}.lock`);
  try {
    mkdirSync(lock);
  } catch {
    throw new CliError(`Another backup of ${name} is running (remove ${lock} if it isn't).`);
  }
  const release = () => { try { rmdirSync(lock); } catch { /* already gone */ } };
  onExit(release);
  return release;
}

// ---------- S3 (through the aws CLI, so any S3-compatible store works) ----------
export function s3Client({ uri, endpoint }) {
  if (!/^s3:\/\/[^/]+/.test(uri)) throw usageError('--s3 must look like s3://bucket/prefix');
  if (!hasCommand('aws')) throw usageError('The aws CLI is needed for S3: https://aws.amazon.com/cli/');
  const base = uri.replace(/\/+$/, '');
  const aws = async (...args) => {
    const r = await run('aws', [...(endpoint ? ['--endpoint-url', endpoint] : []), 's3', ...args, '--only-show-errors']);
    if (r.code !== 0) throw new CliError(`aws s3 ${args[0]}: ${firstLine(r.stderr)}`);
    return r.stdout;
  };
  return {
    base,
    url: (file) => `${base}/${file}`,
    put: (path, file) => aws('cp', path, `${base}/${file}`),
    get: (s3uri, path) => aws('cp', s3uri, path),
    rm: (file) => aws('rm', `${base}/${file}`),
    async list(name = null) {
      let text = '';
      try { text = await aws('ls', `${base}/${name ? `${name}_` : ''}`); } catch { return []; }   // empty prefix
      return text.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 4)
        .map(([, , size, file]) => ({ ...parseBackupName(file), file, size: Number(size), where: 's3', path: `${base}/${file}` }))
        .filter((i) => i.ts && (!name || i.name === name))
        .sort(byTimestamp);
    },
  };
}
