import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDbUrl, label, sameDatabase } from '../src/lib/url.mjs';
import { parseArgs } from '../src/cli/args.mjs';
import { backupFileName, parseBackupName, toPrune } from '../src/lib/storage.mjs';
import { writeChecksum, verifyChecksum } from '../src/lib/checksum.mjs';

test('url: detects the engine from the scheme', () => {
  assert.equal(parseDbUrl('postgres://u@h/db').engine, 'postgres');
  assert.equal(parseDbUrl('postgresql://u@h/db').engine, 'postgres');
  assert.equal(parseDbUrl('mysql://u@h/db').engine, 'mysql');
  assert.equal(parseDbUrl('mariadb://u@h/db').engine, 'mysql');
  assert.throws(() => parseDbUrl('redis://h/0'), /unsupported scheme/);
  assert.throws(() => parseDbUrl('not a url'), /isn't a valid URL/);
  assert.throws(() => parseDbUrl('postgres://h'), /needs a host and a database/);
});

test('url: decodes credentials and applies default ports', () => {
  const c = parseDbUrl('postgres://us%40er:p%40ss%2Fw@[::1]/my%20db?sslmode=require');
  assert.deepEqual(
    { user: c.user, password: c.password, host: c.host, port: c.port, database: c.database, ssl: c.params.sslmode },
    { user: 'us@er', password: 'p@ss/w', host: '::1', port: '5432', database: 'my db', ssl: 'require' },
  );
  assert.equal(parseDbUrl('mysql://h/db').port, '3306');
  assert.equal(label(c), 'us@er@::1:5432/my db');
  assert.ok(sameDatabase(parseDbUrl('postgres://a@h/db'), parseDbUrl('postgres://b:x@h:5432/db')));
  assert.ok(!sameDatabase(parseDbUrl('postgres://h/db'), parseDbUrl('postgres://h/db2')));
});

test('args: flags, short flags, =values, env, defaults, multiples, errors', () => {
  const spec = {
    url: { short: 'u', type: 'string', env: 'TEST_URL' },
    keep: { short: 'k', type: 'number', default: 7 },
    yes: { short: 'y', type: 'boolean' },
    tag: { type: 'string', multiple: true },
    format: { type: 'string', choices: ['a', 'b'] },
    dryRun: { type: 'boolean' },
  };
  process.env.TEST_URL = 'from-env';
  assert.deepEqual(parseArgs(['-k', '3', '--tag=x', '--tag', 'y', '-y', 'pos', '--dry-run'], spec),
    { opts: { keep: 3, tag: ['x', 'y'], yes: true, dryRun: true, url: 'from-env' }, positionals: ['pos'] });
  assert.equal(parseArgs(['--url', 'flag'], spec).opts.url, 'flag');
  delete process.env.TEST_URL;
  assert.throws(() => parseArgs(['--nope'], spec), /Unknown option/);
  assert.throws(() => parseArgs(['--keep', 'x'], spec), /whole number/);
  assert.throws(() => parseArgs(['--url'], spec), /needs a value/);
  assert.throws(() => parseArgs(['--url', '-y'], spec), /needs a value/);
  assert.throws(() => parseArgs(['--yes=1'], spec), /doesn't take a value/);
  assert.throws(() => parseArgs(['--format', 'c'], spec), /one of: a, b/);
});

test('storage: names, parsing and retention', () => {
  const name = backupFileName('my_db', 'dump', new Date('2026-10-27T02:03:04Z'));
  assert.equal(name, 'my_db_20261027-020304.dump');
  assert.deepEqual(parseBackupName(name), { name: 'my_db', ts: '20261027-020304', ext: 'dump' });
  assert.equal(parseBackupName('random.txt'), null);
  const items = ['20250103-000000', '20250101-000000', '20250102-000000'].map((ts) => ({ ts, file: ts }));
  assert.deepEqual(toPrune(items, 1).map((i) => i.ts), ['20250101-000000', '20250102-000000']);
  assert.deepEqual(toPrune(items, 0), []);
  assert.deepEqual(toPrune(items, 5), []);
});

test('checksum: write, verify, detect corruption', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cs-')), 'x.dump');
  writeFileSync(file, 'data');
  assert.equal(await verifyChecksum(file), null);
  await writeChecksum(file);
  assert.equal(await verifyChecksum(file), true);
  appendFileSync(file, '!');
  assert.equal(await verifyChecksum(file), false);
});
