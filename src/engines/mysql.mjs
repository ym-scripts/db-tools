// MySQL and MariaDB: mysqldump / mysql (or mariadb-dump / mariadb). Credentials go in
// a private temporary option file, so passwords never appear in the process list.
import { writeFileSync, rmSync, mkdtempSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { run, runToFile, runFromFile, hasCommand, commandVersion, firstLine } from '../lib/exec.mjs';
import { onExit } from '../lib/cleanup.mjs';
import { pass, warnResult } from '../lib/checks.mjs';
import { CliError, usageError } from '../ui/output.mjs';

const INSTALL = 'Install the MySQL client (macOS: brew install mysql-client · Debian/Ubuntu: apt install mysql-client) or the MariaDB client.';
const tools = {};

function resolveTools() {
  if (tools.dump) return tools;
  tools.dump = ['mysqldump', 'mariadb-dump'].find(hasCommand);
  tools.client = ['mysql', 'mariadb'].find(hasCommand);
  if (!tools.dump || !tools.client) throw usageError(`mysqldump/mysql not found. ${INSTALL}`);
  return tools;
}

// Option-file values are quoted, with backslashes and quotes escaped.
const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const optionFiles = new WeakMap();

/** --defaults-extra-file=<private temp file with this connection's credentials> */
function credentials(conn) {
  if (!optionFiles.has(conn)) {
    const dir = mkdtempSync(join(tmpdir(), 'db-tools-'));
    const file = join(dir, 'client.cnf');
    const ssl = conn.params['ssl-mode'] ?? conn.params.sslmode ?? conn.params.ssl_mode;
    const lines = ['[client]', `host=${quote(conn.host)}`, `port=${conn.port}`];
    if (conn.user) lines.push(`user=${quote(conn.user)}`);
    if (conn.password) lines.push(`password=${quote(conn.password)}`);
    if (ssl) lines.push(`ssl-mode=${String(ssl).toUpperCase().replace(/^REQUIRE$/, 'REQUIRED')}`);
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    onExit(() => rmSync(dir, { recursive: true, force: true }));
    optionFiles.set(conn, `--defaults-extra-file=${file}`);
  }
  return optionFiles.get(conn);
}

async function query(conn, sql) {
  const { client } = resolveTools();
  const r = await run(client, [credentials(conn), '-N', '-B', '-e', sql, conn.database]);
  if (r.code !== 0) throw new CliError(firstLine(r.stderr, `${client} exited with ${r.code}`));
  const text = r.stdout.replace(/\n$/, '');
  return text ? text.split('\n').map((l) => l.split('\t')) : [];
}

const ident = (name) => `\`${name.replace(/`/g, '``')}\``;

/** mysqldump ends a complete dump with "-- Dump completed". */
async function dumpIsComplete(file) {
  let tail = '';
  for await (const chunk of createReadStream(file).pipe(createGunzip())) tail = (tail + chunk).slice(-200);
  return tail.includes('Dump completed');
}

export default {
  id: 'mysql',
  name: 'MySQL / MariaDB',
  formats: ['sql'],
  restoreExts: ['sql.gz'],
  query,

  checkTools() {
    const { dump } = resolveTools();
    const v = commandVersion(dump) ?? dump;
    return { summary: v.replace(/^.*?(Ver|Distrib)\s*/, `${dump} `).split(',')[0], major: parseInt(v.match(/(\d+)\.\d+/)?.[1] ?? '0', 10) };
  },

  async info(conn) {
    const [r] = await query(conn, `select version(), @@character_set_database, @@collation_database,
      (select coalesce(sum(data_length + index_length), 0) from information_schema.tables where table_schema = database()),
      (select count(*) from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE')`);
    return { version: r[0], major: parseInt(r[0], 10), mariadb: /mariadb/i.test(r[0]), encoding: r[1], collate: r[2], size: Number(r[3]), tables: Number(r[4]) };
  },

  backupExt: () => 'sql.gz',

  async dump(conn, file) {
    const { dump } = resolveTools();
    const r = await runToFile(dump, [credentials(conn), '--single-transaction', '--quick', '--routines', '--triggers',
      '--no-tablespaces', '--hex-blob', '--default-character-set=utf8mb4', conn.database], { file, gzip: true });
    if (r.code !== 0) throw new CliError(`${dump} failed: ${firstLine(r.stderr)}`);
    if (!(await dumpIsComplete(file))) throw new CliError(`${dump} output is incomplete (no "Dump completed" marker)`);
  },

  async restore(conn, file) {
    if (!file.endsWith('.sql.gz')) throw usageError(`Can't restore ${file} into MySQL (expected .sql.gz)`);
    const { client } = resolveTools();
    const r = await runFromFile(client, [credentials(conn), conn.database], { file, gunzip: true });
    return r.code === 0 ? [] : [firstLine(r.stderr, `${client} exited with ${r.code}`)];
  },

  async tableCounts(conn) {
    const tables = (await query(conn, `select table_name from information_schema.tables where table_schema = database() and table_type = 'BASE TABLE' order by 1`)).map((r) => r[0]);
    if (!tables.length) return new Map();
    const sql = tables.map((t) => `select ${`'${t.replace(/'/g, "''")}'`}, count(*) from ${ident(t)}`).join(' union all ');
    return new Map((await query(conn, sql)).map(([t, n]) => [t, n]));
  },

  async userTableCount(conn) {
    return (await this.info(conn)).tables;
  },

  async preflight(src, tgt, checks, ctx) {
    await checks.run('Server compatibility', () => {
      if (ctx.src.mariadb !== ctx.tgt.mariadb) return warnResult(`copying between MySQL and MariaDB (${ctx.src.version} → ${ctx.tgt.version}); test the app carefully`);
      if (ctx.tgt.major < ctx.src.major) throw new Error(`target ${ctx.tgt.version} is older than source ${ctx.src.version}`);
      return pass(`${ctx.src.version} → ${ctx.tgt.version}`);
    });
    await checks.run('Character set and collation', () =>
      ctx.src.encoding !== ctx.tgt.encoding || ctx.src.collate !== ctx.tgt.collate
        ? warnResult(`database defaults differ (${ctx.src.encoding}/${ctx.src.collate} vs ${ctx.tgt.encoding}/${ctx.tgt.collate}); tables keep their own`)
        : pass(`${ctx.src.encoding}, ${ctx.src.collate}`));
    await checks.run('Target uses SSL', () => {
      const ssl = tgt.params['ssl-mode'] ?? tgt.params.sslmode;
      return !ssl && tgt.host !== 'localhost' && tgt.host !== '127.0.0.1' ? warnResult('add ?ssl-mode=required to the target URL') : pass(ssl || 'local');
    });
  },

  async objectSummary(conn) {
    const rows = await query(conn, `
      select 'views', count(*) from information_schema.views where table_schema = database()
      union all select 'routines', count(*) from information_schema.routines where routine_schema = database()
      union all select 'triggers', count(*) from information_schema.triggers where trigger_schema = database()
      union all select 'indexes', count(distinct table_name, index_name) from information_schema.statistics where table_schema = database()`);
    return new Map(rows);
  },

  shell(conn) {
    const { client } = resolveTools();
    return { cmd: client, args: [credentials(conn), conn.database], env: process.env };
  },
};
