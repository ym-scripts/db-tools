// PostgreSQL: pg_dump / pg_restore / psql. Credentials go through PG* environment
// variables, so passwords never appear in the process list.
import { setTimeout as sleep } from 'node:timers/promises';
import { run, runToFile, runFromFile, commandVersion, firstLine } from '../lib/exec.mjs';
import { isLocalHost } from '../lib/url.mjs';
import { pass, warnResult } from '../lib/checks.mjs';
import { CliError, usageError } from '../ui/output.mjs';

const INSTALL = 'Install the PostgreSQL client tools (macOS: brew install libpq && brew link --force libpq · Debian/Ubuntu: apt install postgresql-client).';
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const notIn = (excludeSchemas = []) => `(${['pg_catalog', 'information_schema', ...excludeSchemas].map(lit).join(',')})`;

function env(conn) {
  return {
    ...process.env,
    PGHOST: conn.host,
    PGPORT: conn.port,
    PGUSER: conn.user,
    PGDATABASE: conn.database,
    PGSSLMODE: conn.params.sslmode || 'prefer',
    PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'db-tools',
    ...(conn.password ? { PGPASSWORD: conn.password } : {}),
  };
}

async function query(conn, sql) {
  const r = await run('psql', ['-X', '-A', '-t', '-q', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', sql], { env: env(conn) });
  if (r.code !== 0) throw new CliError(firstLine(r.stderr, `psql exited with ${r.code}`));
  const text = r.stdout.trim();
  return text ? text.split('\n').map((l) => l.split('\t')) : [];
}

export default {
  id: 'postgres',
  name: 'PostgreSQL',
  formats: ['custom', 'plain'],
  restoreExts: ['dump', 'sql.gz'],
  query,

  checkTools() {
    const versions = {};
    for (const tool of ['pg_dump', 'pg_restore', 'psql']) {
      const v = commandVersion(tool);
      if (!v) throw usageError(`${tool} not found. ${INSTALL}`);
      versions[tool] = v.replace(/^.*\) /, '');
    }
    return { summary: `pg_dump ${versions.pg_dump}`, major: parseInt(versions.pg_dump, 10) };
  },

  async info(conn) {
    const [r] = await query(conn, `select current_setting('server_version_num')::int, current_setting('server_version'), current_setting('server_encoding'),
      (select datcollate from pg_database where datname = current_database()), pg_database_size(current_database()),
      (select count(*) from pg_tables where schemaname not in ${notIn()})`);
    return { major: Math.floor(Number(r[0]) / 10000), version: r[1], encoding: r[2], collate: r[3], size: Number(r[4]), tables: Number(r[5]) };
  },

  backupExt: (format = 'custom') => (format === 'plain' ? 'sql.gz' : 'dump'),

  async dump(conn, file, { format = 'custom', excludeSchemas = [] } = {}) {
    const exclude = excludeSchemas.flatMap((s) => ['--exclude-schema', s]);
    if (format === 'plain') {
      const r = await runToFile('pg_dump', ['--clean', '--if-exists', '--no-owner', '--no-privileges', ...exclude], { env: env(conn), file, gzip: true });
      if (r.code !== 0) throw new CliError(`pg_dump failed: ${firstLine(r.stderr)}`);
      return;
    }
    const r = await run('pg_dump', ['-Fc', ...exclude, '-f', file], { env: env(conn) });
    if (r.code !== 0) throw new CliError(`pg_dump failed: ${firstLine(r.stderr)}`);
    const check = await run('pg_restore', ['--list', file]);
    if (check.code !== 0) throw new CliError(`The dump can't be read back: ${firstLine(check.stderr)}`);
  },

  /** Returns the error lines; an empty list means a clean restore. */
  async restore(conn, file, { jobs = 2 } = {}) {
    let r;
    if (file.endsWith('.dump')) {
      r = await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '-j', String(jobs), '-d', conn.database, file], { env: env(conn) });
    } else if (file.endsWith('.sql.gz')) {
      r = await runFromFile('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], { env: env(conn), file, gunzip: true });
    } else {
      throw usageError(`Can't restore ${file} into PostgreSQL (expected .dump or .sql.gz)`);
    }
    const errors = [...new Set(r.stderr.split('\n').filter((l) => /error/i.test(l)))];
    if (r.code !== 0 && !errors.length) errors.push(firstLine(r.stderr, `exited with ${r.code}`));
    return errors;
  },

  async tableCounts(conn, { excludeSchemas = [] } = {}) {
    const rows = await query(conn, `select format('%I.%I', schemaname, tablename),
      (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text
      from pg_tables where schemaname not in ${notIn(excludeSchemas)} order by 1`);
    return new Map(rows);
  },

  async userTableCount(conn, { excludeSchemas = [] } = {}) {
    const [[n]] = await query(conn, `select count(*) from pg_tables where schemaname not in ${notIn(excludeSchemas)}`);
    return Number(n);
  },

  /** Engine-specific migrate checks. ctx has src/tgt info and the client major version. */
  async preflight(src, tgt, checks, ctx) {
    await checks.run('Source connection type', () =>
      /pooler/i.test(src.host) || src.port === '6432'
        ? warnResult('looks like a pooled connection; use the direct one or pg_dump may fail')
        : pass('direct connection'));
    await checks.run('Target uses SSL', () =>
      !isLocalHost(tgt.host) && !['require', 'verify-ca', 'verify-full'].includes(tgt.params.sslmode)
        ? warnResult('add ?sslmode=require to the target URL')
        : pass(tgt.params.sslmode || 'local'));
    await checks.run('Version compatibility', () => {
      if (ctx.client < ctx.src.major) throw new Error(`local pg_dump ${ctx.client} is older than source server ${ctx.src.major}; upgrade the client tools`);
      if (ctx.tgt.major < ctx.src.major) throw new Error(`target PG ${ctx.tgt.major} is older than source PG ${ctx.src.major}`);
      return pass(`client ${ctx.client}, source ${ctx.src.major}, target ${ctx.tgt.major}`);
    });
    await checks.run('Encoding and collation', () => {
      if (ctx.src.encoding !== ctx.tgt.encoding) throw new Error(`encoding differs (${ctx.src.encoding} vs ${ctx.tgt.encoding})`);
      if (ctx.src.collate !== ctx.tgt.collate) return warnResult(`collation differs (${ctx.src.collate} vs ${ctx.tgt.collate}); sorting may change`);
      return pass(`${ctx.src.encoding}, ${ctx.src.collate}`);
    });
    await checks.run('Extensions available on target', async () => {
      const used = (await query(src, `select extname from pg_extension where extname <> 'plpgsql' order by 1`)).map((r) => r[0]);
      if (!used.length) return pass('none in use');
      const available = new Set((await query(tgt, 'select name from pg_available_extensions')).map((r) => r[0]));
      const missing = used.filter((e) => !available.has(e));
      if (missing.length) throw new Error(`not available on target: ${missing.join(', ')}`);
      return pass(used.join(', '));
    });
    await checks.run('Target permissions', async () => {
      const [[db, schema]] = await query(tgt, `select has_database_privilege(current_user, current_database(), 'CREATE'), has_schema_privilege(current_user, 'public', 'CREATE')`);
      if (db !== 't') throw new Error('user lacks CREATE on the target database');
      return schema === 't' ? pass('can create objects') : warnResult('user cannot create in schema public');
    });
    await checks.run('Source tables readable', async () => {
      const [[n]] = await query(src, `select count(*) from pg_tables where schemaname not in ${notIn(ctx.excludeSchemas)} and not has_table_privilege(format('%I.%I', schemaname, tablename), 'SELECT')`);
      if (Number(n) > 0) throw new Error(`${n} tables the source user cannot SELECT from`);
      return pass();
    });
    await checks.run('No writes to source right now', async () => {
      const sql = 'select coalesce(tup_inserted + tup_updated + tup_deleted, 0) from pg_stat_database where datname = current_database()';
      const [[a]] = await query(src, sql);
      await sleep(4000);
      const [[b]] = await query(src, sql);
      const diff = BigInt(b) - BigInt(a);
      return diff ? warnResult(`${diff} row changes in 4s; stop the app for a consistent copy`) : pass('idle for 4s');
    });
  },

  /** Object counts plus sequence values, for verification after a migrate. */
  async objectSummary(conn, { excludeSchemas = [] } = {}) {
    const ns = notIn(excludeSchemas);
    const rows = await query(conn, `
      select 'indexes', count(*)::text from pg_indexes where schemaname not in ${ns}
      union all select 'views', count(*)::text from pg_views where schemaname not in ${ns}
      union all select 'constraints', count(*)::text from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname not in ${ns} and c.contype in ('p','f','u','c')
      union all select 'triggers', count(*)::text from pg_trigger t join pg_class r on r.oid = t.tgrelid join pg_namespace n on n.oid = r.relnamespace where not t.tgisinternal and n.nspname not in ${ns}
      union all select 'functions', count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ${ns} and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      union all select 'sequence ' || format('%I.%I', schemaname, sequencename), coalesce(last_value::text, 'unused') from pg_sequences where schemaname not in ${ns}`);
    return new Map(rows);
  },

  shell: (conn) => ({ cmd: 'psql', args: [], env: env(conn) }),
};
