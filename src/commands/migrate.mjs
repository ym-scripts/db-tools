// Copies one database into another of the same engine: pre-flight checks, a plan,
// confirmation, dump + restore, then verification of row counts and objects.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opt, connection } from './shared.mjs';
import { confirmByName } from './restore.mjs';
import { createChecks, pass, warnResult } from '../lib/checks.mjs';
import { label, sameDatabase } from '../lib/url.mjs';
import { onExit } from '../lib/cleanup.mjs';
import { log, c, icon, fmtBytes, fmtSecs, withSpinner, CliError, usageError } from '../ui/output.mjs';
import { isInteractive, confirm } from '../ui/prompts.mjs';

async function preflight(src, tgt, o) {
  const checks = createChecks();
  const ctx = { excludeSchemas: o.excludeSchema ?? [] };
  log(c.bold('\nPre-flight checks'));

  await checks.run('Same database engine', () => {
    if (src.conn.engine !== tgt.conn.engine) throw new Error(`can't copy ${src.engine.name} into ${tgt.engine.name}`);
    return pass(src.engine.name);
  });
  if (checks.count('fail')) return { checks, ctx };

  const tools = await checks.run('Client tools installed', () => {
    const t = src.engine.checkTools();
    ctx.client = t.major;
    return pass(t.summary);
  });
  await checks.run('Source and target are different', () => {
    if (sameDatabase(src.conn, tgt.conn)) throw new Error('both URLs point to the same database');
    return pass();
  });

  const reach = async (side, name) => {
    if (!tools) return checks.skip(name, 'client tools missing');
    return checks.run(name, async () => {
      ctx[side] = await (side === 'src' ? src : tgt).engine.info((side === 'src' ? src : tgt).conn);
      return pass(`${ctx[side].version}${side === 'src' ? `, ${fmtBytes(ctx.src.size)}, ${ctx.src.tables} tables` : ''}`);
    });
  };
  const srcOk = await reach('src', 'Source reachable');
  const tgtOk = await reach('tgt', 'Target reachable');
  if (!srcOk || !tgtOk) return { checks, ctx };

  await src.engine.preflight(src.conn, tgt.conn, checks, ctx);
  await checks.run('Target is empty', async () => {
    ctx.targetTables = await tgt.engine.userTableCount(tgt.conn, { excludeSchemas: ctx.excludeSchemas });
    return ctx.targetTables ? warnResult(`${ctx.targetTables} existing tables will be OVERWRITTEN`) : pass('no user tables');
  });
  await checks.run('Disk space for the dump', async () => {
    const fs = await statfs(tmpdir());
    const free = fs.bavail * fs.bsize;
    if (free < ctx.src.size * 0.25) throw new Error(`only ${fmtBytes(free)} free in ${tmpdir()}, database is ${fmtBytes(ctx.src.size)}`);
    return free < ctx.src.size ? warnResult(`${fmtBytes(free)} free; the dump is compressed but this is tight`) : pass(`${fmtBytes(free)} free`);
  });
  return { checks, ctx };
}

async function verify(src, tgt, baseline, o) {
  log(c.bold('\nVerifying'));
  const opts = { excludeSchemas: o.excludeSchema ?? [] };
  const after = await tgt.engine.tableCounts(tgt.conn, opts);
  let problems = 0;
  const width = Math.max(5, ...[...baseline.keys()].map((k) => k.length));
  log(c.dim(`  ${'TABLE'.padEnd(width + 2)}${'SOURCE'.padStart(12)}  ${'TARGET'.padStart(12)}`));
  for (const [table, n] of baseline) {
    const m = after.get(table) ?? 'MISSING';
    const ok = m === n;
    if (!ok) problems++;
    log(`  ${ok ? icon.pass : icon.fail} ${table.padEnd(width)}  ${n.padStart(12)}  ${String(m).padStart(12)}${ok ? '' : c.red('  mismatch')}`);
  }

  const [a, b] = await Promise.all([src.engine.objectSummary(src.conn, opts), tgt.engine.objectSummary(tgt.conn, opts)]);
  const seqDiff = [...a].filter(([k, v]) => k.startsWith('sequence ') && b.get(k) !== v);
  const objDiff = [...a].filter(([k, v]) => !k.startsWith('sequence ') && b.get(k) !== v);
  const seqCount = [...a.keys()].filter((k) => k.startsWith('sequence ')).length;
  if (seqCount) log(`  ${seqDiff.length ? icon.fail : icon.pass} Sequences: ${seqCount} checked${seqDiff.length ? c.red(`, ${seqDiff.length} differ`) : ''}`);
  problems += seqDiff.length;
  const objects = [...a].filter(([k]) => !k.startsWith('sequence '));
  log(objDiff.length
    ? `  ${icon.warn} Objects differ: ${objDiff.map(([k, v]) => `${k} ${v}→${b.get(k) ?? 0}`).join(', ')}`
    : `  ${icon.pass} Objects: ${objects.map(([k, v]) => `${v} ${k}`).join(', ')}`);
  return problems;
}

export default {
  name: 'migrate',
  summary: 'Copy one database into another, with checks and verification',
  usage: 'migrate --from URL --to URL [options]',
  examples: [
    'migrate                                   # asks for both URLs',
    'migrate --from "$OLD_URL" --to "$NEW_URL" --dry-run',
    'migrate --from "$OLD_URL" --to "$NEW_URL" --yes --overwrite',
  ],
  spec: {
    from: { type: 'string', arg: 'URL', env: 'SOURCE_URL', desc: 'Source (current) database URL' },
    to: { type: 'string', arg: 'URL', env: 'TARGET_URL', desc: 'Target (new) database URL' },
    dryRun: { short: 'n', type: 'boolean', desc: 'Run the checks, then stop. Changes nothing.' },
    jobs: { type: 'number', arg: 'N', default: 2, desc: 'PostgreSQL: parallel pg_restore jobs' },
    excludeSchema: { type: 'string', arg: 'NAME', multiple: true, desc: 'PostgreSQL: skip a schema (repeatable)' },
    keepDump: { type: 'boolean', desc: 'Keep the dump file afterwards' },
    yes: opt.yes,
    overwrite: { type: 'boolean', desc: 'With --yes, allow replacing data in a non-empty target' },
    help: opt.help,
  },

  async run(o) {
    const src = await connection(o.from, { what: 'Source (current) database URL', flag: '--from' });
    const tgt = await connection(o.to, { what: 'Target (new) database URL', flag: '--to' });
    if (o.excludeSchema && src.conn.engine !== 'postgres') throw usageError('--exclude-schema is PostgreSQL only');
    log(`\n  Source: ${c.bold(label(src.conn))}\n  Target: ${c.bold(label(tgt.conn))}`);

    const { checks, ctx } = await preflight(src, tgt, o);
    const fails = checks.count('fail');
    const warns = checks.warnings();
    log(`\n  ${c.green(`${checks.count('pass')} passed`)}  ${warns.length ? c.yellow(`${warns.length} warnings`) : c.dim('0 warnings')}  ${fails ? c.red(`${fails} failed`) : c.dim('0 failed')}\n`);
    if (fails) throw new CliError('Not ready. Fix the failed checks and run again. Nothing was changed.');
    if (o.dryRun) return log('Dry run complete. Nothing was changed.');

    log(c.bold('Plan'));
    log(`  Copy ${c.bold(`${ctx.src.tables} tables`)} (${fmtBytes(ctx.src.size)}) from ${c.bold(label(src.conn))}`);
    log(`  into ${c.bold(label(tgt.conn))}`);
    log(c.dim('  The source is only read. Target objects with the same names are dropped and recreated.'));
    for (const w of warns) log(`  ${icon.warn} ${w.name}: ${w.msg}`);

    if (o.yes) {
      if (ctx.targetTables && !o.overwrite) throw new CliError('Target is not empty. Pass --overwrite together with --yes to replace its data. Nothing was changed.');
    } else if (ctx.targetTables) {
      await confirmByName(tgt.conn, 'The target already has data that WILL BE OVERWRITTEN.', false);
    } else {
      if (!isInteractive()) throw usageError('No terminal to confirm on. Pass --yes to run without a prompt.');
      if (!(await confirm({ message: '\nStart the migration?' }))) throw new CliError('Cancelled. Nothing was changed.');
    }

    const t0 = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'db-tools-migrate-'));
    const dump = join(dir, `source.${src.engine.backupExt('custom')}`);
    let keep = Boolean(o.keepDump);
    onExit(() => { if (!keep) rmSync(dir, { recursive: true, force: true }); });

    log(c.bold('\nMigrating'));
    const opts = { excludeSchemas: o.excludeSchema ?? [] };
    const baseline = await withSpinner('Counting source rows', () => src.engine.tableCounts(src.conn, opts));
    log(`  ${icon.pass} Counted rows in ${baseline.size} source tables`);
    await withSpinner('Dumping source', () => src.engine.dump(src.conn, dump, { format: 'custom', ...opts }), dump);
    log(`  ${icon.pass} Dumped source ${c.dim(fmtBytes(statSync(dump).size))}`);
    const errors = await withSpinner('Restoring into target', () => tgt.engine.restore(tgt.conn, dump, { jobs: o.jobs }));
    if (errors.length) {
      log(`  ${icon.warn} Restore reported ${errors.length} error line(s) ${c.dim('(often harmless ownership notices; verification decides)')}`);
      for (const e of errors.slice(0, 10)) log(c.dim(`      ${e.slice(0, 200)}`));
    } else {
      log(`  ${icon.pass} Restored into target`);
    }

    const problems = await verify(src, tgt, baseline, o);
    if (problems) {
      keep = true;
      log(`  Dump kept at ${dump}`);
      throw new CliError(`Verification FAILED (${problems} problem${problems > 1 ? 's' : ''}). If the source received writes during the run, re-run with writes stopped.`);
    }
    log(c.green(`\n${icon.pass} Migration complete and verified in ${fmtSecs(Date.now() - t0)}.`));
    log(c.dim('  Next: point your app at the new URL, redeploy, smoke test, and keep the old database for a few days.'));
    if (o.keepDump) log(c.dim(`  Dump kept at ${dump}`));
  },
};
