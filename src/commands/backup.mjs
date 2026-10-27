import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { opt, connection, guided } from './shared.mjs';
import { label } from '../lib/url.mjs';
import { writeChecksum } from '../lib/checksum.mjs';
import { backupFileName, acquireLock, s3Client, removeLocal } from '../lib/storage.mjs';
import { pruneBackups } from './prune.mjs';
import { onExit } from '../lib/cleanup.mjs';
import { log, c, icon, fmtBytes, fmtSecs, withSpinner, warn, usageError } from '../ui/output.mjs';
import { statSync } from 'node:fs';

async function ping(url) {
  if (!url) return;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    warn(`Health-check ping failed (${url}): ${e.message}`);
  }
}

export default {
  name: 'backup',
  summary: 'Back up a database to a local folder and, optionally, S3',
  usage: 'backup [options]',
  examples: [
    'backup --url postgres://user:pass@host/db',
    'backup --keep 14 --s3 s3://bucket/db --s3-endpoint https://<id>.r2.cloudflarestorage.com',
    'backup --format plain           # PostgreSQL: .sql.gz instead of pg_dump -Fc',
  ],
  spec: {
    url: opt.url, dir: opt.dir, keep: opt.keep, name: opt.name,
    format: { type: 'string', arg: 'F', choices: ['custom', 'plain'], default: 'custom', desc: 'PostgreSQL only: custom (pg_dump -Fc) or plain (.sql.gz)' },
    excludeSchema: { type: 'string', arg: 'NAME', multiple: true, desc: 'PostgreSQL only: skip a schema (repeatable)' },
    s3: opt.s3, s3Endpoint: opt.s3Endpoint,
    s3Only: { type: 'boolean', desc: 'Delete the local copy after uploading' },
    ping: { type: 'string', arg: 'URL', env: 'BACKUP_PING_URL', desc: 'GET URL on success, URL/fail on failure' },
    quiet: opt.quiet, help: opt.help,
  },

  async run(o, ctx) {
    const { conn, engine } = await connection(o.url);
    o.dir = await guided(ctx, o.dir, { message: 'Backup folder:' });
    o.keep = Number(await guided(ctx, o.keep, { message: 'Keep how many backups? (0 = all)', validate: (v) => (/^\d+$/.test(v) ? null : 'Enter a number') }));
    o.s3 = (await guided(ctx, o.s3, { message: `Also upload to S3? ${c.dim('s3://bucket/prefix, or leave empty')}` })) || undefined;
    if (o.s3Only && !o.s3) throw usageError('--s3-only needs --s3');
    if (o.name?.includes('/')) throw usageError("--name can't contain /");
    if (conn.engine !== 'postgres' && (o.format !== 'custom' || o.excludeSchema)) throw usageError('--format and --exclude-schema are PostgreSQL only');

    engine.checkTools();
    const s3 = o.s3 ? s3Client({ uri: o.s3, endpoint: o.s3Endpoint }) : null;
    const name = o.name || conn.database;
    acquireLock(o.dir, name);

    const file = backupFileName(name, engine.backupExt(o.format));
    const path = join(o.dir, file);
    const partial = join(o.dir, `.${file}.partial`);
    const dropPartial = onExit(() => removeLocal(partial));
    log(`${c.bold('Backing up')} ${label(conn)} ${c.dim(`(${engine.name})`)}`);

    const t0 = Date.now();
    try {
      await withSpinner('Dumping', () => engine.dump(conn, partial, { format: o.format, excludeSchemas: o.excludeSchema }), partial);
      await rename(partial, path);
      dropPartial();
      await writeChecksum(path);
      log(`  ${icon.pass} ${path} ${c.dim(`${fmtBytes(statSync(path).size)} in ${fmtSecs(Date.now() - t0)}`)}`);

      if (s3) {
        await withSpinner('Uploading', async () => {
          await s3.put(path, file);
          await s3.put(`${path}.sha256`, `${file}.sha256`);
        });
        log(`  ${icon.pass} ${s3.url(file)}`);
        if (o.s3Only) removeLocal(path);
      }
    } catch (e) {
      await ping(o.ping && `${o.ping.replace(/\/$/, '')}/fail`);
      if (s3 && statSyncSafe(path)) e.message += ` (the local backup was kept at ${path})`;
      throw e;
    }

    await pruneBackups({ dir: o.dir, name, keep: o.keep, s3, localToo: !o.s3Only });
    await ping(o.ping);
    console.log(o.s3Only ? s3.url(file) : path);
  },
};

function statSyncSafe(p) {
  try { return statSync(p); } catch { return null; }
}
