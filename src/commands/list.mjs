import { opt, connection } from './shared.mjs';
import { listLocal, s3Client } from '../lib/storage.mjs';
import { log, c, fmtBytes } from '../ui/output.mjs';

const fmtTs = (ts) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)} UTC`;

export default {
  name: 'list',
  summary: 'List backups, oldest first',
  usage: 'list [options]',
  spec: { dir: opt.dir, name: opt.name, url: { ...opt.url, desc: 'Only backups of this database' }, s3: opt.s3, s3Endpoint: opt.s3Endpoint, json: { type: 'boolean', desc: 'JSON output' }, help: opt.help },

  async run(o) {
    let name = o.name;
    if (!name && o.url) name = (await connection(o.url)).conn.database;
    const items = [...(await listLocal(o.dir, name))];
    if (o.s3) items.push(...(await s3Client({ uri: o.s3, endpoint: o.s3Endpoint }).list(name)));

    if (o.json) return console.log(JSON.stringify(items, null, 2));
    if (!items.length) return log(c.dim(`No backups${name ? ` of ${name}` : ''} in ${o.dir}${o.s3 ? ` or ${o.s3}` : ''}.`));
    for (const i of items) console.log(`${fmtTs(i.ts)}  ${fmtBytes(i.size).padStart(9)}  ${i.where === 's3' ? c.cyan('s3   ') : c.dim('local')}  ${i.path}`);
  },
};
