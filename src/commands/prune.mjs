import { opt, connection } from './shared.mjs';
import { listLocal, toPrune, removeLocal, s3Client } from '../lib/storage.mjs';
import { log, c, icon, usageError } from '../ui/output.mjs';
import { isInteractive, select } from '../ui/prompts.mjs';

/** Deletes all but the newest `keep` backups of `name`, locally and on S3. */
export async function pruneBackups({ dir, name, keep, s3, localToo = true }) {
  if (!keep) return;
  if (localToo) {
    for (const item of toPrune(await listLocal(dir, name), keep)) {
      removeLocal(item.path);
      log(`  ${icon.dot} pruned ${item.file}`);
    }
  }
  if (s3) {
    for (const item of toPrune(await s3.list(name), keep)) {
      await s3.rm(item.file);
      await s3.rm(`${item.file}.sha256`).catch(() => {});
      log(`  ${icon.dot} pruned ${s3.url(item.file)}`);
    }
  }
}

export default {
  name: 'prune',
  summary: 'Delete old backups, keeping the newest N',
  usage: 'prune --name NAME [--keep N] [options]',
  spec: { name: opt.name, url: { ...opt.url, desc: 'Use this database name as --name' }, dir: opt.dir, keep: opt.keep, s3: opt.s3, s3Endpoint: opt.s3Endpoint, quiet: opt.quiet, help: opt.help },

  async run(o) {
    let name = o.name;
    if (!name && o.url) name = (await connection(o.url)).conn.database;
    if (!name) {
      const names = [...new Set((await listLocal(o.dir)).map((i) => i.name))];
      if (!names.length) throw usageError(`No backups in ${o.dir}.`);
      if (!isInteractive()) throw usageError('Pass --name (or --url) so prune knows which backups to keep.');
      name = await select({ message: 'Which backups?', choices: names.map((n) => ({ value: n, label: n })) });
    }
    if (!o.keep) throw usageError('--keep 0 keeps everything, so there is nothing to prune.');
    const s3 = o.s3 ? s3Client({ uri: o.s3, endpoint: o.s3Endpoint }) : null;
    log(`Keeping the newest ${c.bold(o.keep)} backups of ${c.bold(name)}`);
    await pruneBackups({ dir: o.dir, name, keep: o.keep, s3 });
  },
};
