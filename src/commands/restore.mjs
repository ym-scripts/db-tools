import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { opt, connection, describe } from './shared.mjs';
import { verifyChecksum } from '../lib/checksum.mjs';
import { listLocal, s3Client } from '../lib/storage.mjs';
import { onExit } from '../lib/cleanup.mjs';
import { label } from '../lib/url.mjs';
import { log, c, icon, withSpinner, CliError, usageError } from '../ui/output.mjs';
import { isInteractive, select, input } from '../ui/prompts.mjs';

async function pickBackup(dir) {
  const items = (await listLocal(dir)).reverse();
  if (!isInteractive()) throw usageError('Which backup? db-tools restore FILE --url URL');
  if (!items.length) return input({ message: 'Backup file (path or s3:// URI):', validate: (v) => (v ? null : 'Required') });
  const choice = await select({
    message: 'Which backup?',
    choices: [...items.slice(0, 15).map((i) => ({ value: i.path, label: i.file })), { value: null, label: 'Another file or s3:// URI…' }],
  });
  return choice ?? input({ message: 'Backup file (path or s3:// URI):', validate: (v) => (v ? null : 'Required') });
}

/** Asks the user to type the database name. --yes skips it. */
export async function confirmByName(conn, what, yes) {
  if (yes) return;
  if (!isInteractive()) throw usageError('No terminal to confirm on. Pass --yes to run without a prompt.');
  log(c.yellow(`\n${what}`));
  const typed = await input({ message: `Type the database name (${c.bold(conn.database)}) to continue:` });
  if (typed !== conn.database) throw new CliError('Cancelled. Nothing was changed.');
}

export default {
  name: 'restore',
  summary: 'Restore a backup (local file or s3:// URI) into a database',
  usage: 'restore [FILE] --url URL [options]',
  examples: ['restore ./backups/shop_20261027-020000.dump --url postgres://…', 'restore s3://bucket/db/shop_20261027-020000.sql.gz --url mysql://…'],
  spec: { url: { ...opt.url, desc: 'Target database URL' }, dir: { ...opt.dir, desc: 'Folder to pick a backup from' }, s3Endpoint: opt.s3Endpoint, jobs: { type: 'number', arg: 'N', default: 2, desc: 'PostgreSQL: parallel pg_restore jobs' }, yes: opt.yes, quiet: opt.quiet, help: opt.help },

  async run(o, ctx) {
    if (ctx.positionals.length > 1) throw usageError(`Unexpected argument: ${ctx.positionals[1]}`);
    let file = ctx.positionals[0] ?? (await pickBackup(o.dir));
    const { conn, engine } = await connection(o.url, { what: 'Target database URL' });
    if (!engine.restoreExts.some((x) => file.endsWith(`.${x}`))) {
      throw usageError(`${basename(file)} can't be restored into ${engine.name} (expected ${engine.restoreExts.map((x) => `.${x}`).join(' or ')}).`);
    }
    engine.checkTools();
    describe(conn, engine);

    if (file.startsWith('s3://')) {
      const s3 = s3Client({ uri: file.slice(0, file.lastIndexOf('/')), endpoint: o.s3Endpoint });
      const dir = mkdtempSync(join(tmpdir(), 'db-tools-'));
      onExit(() => rmSync(dir, { recursive: true, force: true }));
      const local = join(dir, basename(file));
      await withSpinner(`Downloading ${basename(file)}`, async () => {
        await s3.get(file, local);
        await s3.get(`${file}.sha256`, `${local}.sha256`).catch(() => {});
      });
      file = local;
    } else if (!existsSync(file)) {
      throw usageError(`No such file: ${file}`);
    }

    const ok = await verifyChecksum(file);
    if (ok === false) throw new CliError(`Checksum mismatch for ${basename(file)}. The file is corrupt.`);
    log(ok ? `  ${icon.pass} checksum OK` : `  ${icon.warn} no .sha256 file, can't verify integrity`);

    await confirmByName(conn, `This replaces objects in ${label(conn)} with the contents of ${basename(file)}.`, o.yes);
    const errors = await withSpinner('Restoring', () => engine.restore(conn, file, { jobs: o.jobs }));
    if (errors.length) {
      for (const e of errors.slice(0, 10)) log(c.dim(`    ${e.slice(0, 200)}`));
      throw new CliError(`Restore finished with ${errors.length} error(s). Some objects may not have been restored.`);
    }
    log(`  ${icon.pass} Restored into ${label(conn)}`);
  },
};
