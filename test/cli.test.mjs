import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { workspace, PG, MY } from './helpers.mjs';

test('usage errors exit 2', () => {
  const w = workspace();
  assert.equal(w.run(['explode']).code, 2);
  assert.equal(w.run(['backup', '--nope']).code, 2);
  assert.equal(w.run(['backup']).code, 2);                                   // no URL, no terminal
  assert.match(w.run(['backup', '--url', 'redis://h/0']).out, /unsupported scheme/);
  assert.equal(w.run(['backup', '--url', MY, '--format', 'plain']).code, 2); // PostgreSQL only
  assert.equal(w.run(['backup', '--url', PG, '--s3-only']).code, 2);
  assert.equal(w.run(['list', 'extra']).code, 2);
  assert.equal(w.run(['--version']).code, 0);
  assert.match(w.run([]).stdout, /Commands:/);                               // no terminal: help, not a menu
  assert.match(w.run(['help', 'restore']).stdout, /restore \[FILE\]/);
});

test('backup: PostgreSQL custom format', () => {
  const w = workspace();
  const r = w.run(['backup', '--url', PG]);
  assert.equal(r.code, 0, r.out);
  const [dump, sum] = w.files();
  assert.match(dump, /^shop_\d{8}-\d{6}\.dump$/);
  assert.equal(sum, `${dump}.sha256`);
  assert.equal(r.stdout.trim(), `backups/${dump}`);
  assert.match(w.log(), /user=app pass=p@ss\/w host=db\.example\.com port=6543 db=shop ssl=require/);
  assert.match(w.log(), /pg_restore --list/);
  assert.doesNotMatch(w.log(), /p@ss\/w.*\|.*p@ss|pg_dump.*p@ss.*\|/);  // password only in env, not args
});

test('backup: PostgreSQL plain format is gzipped SQL', () => {
  const w = workspace();
  assert.equal(w.run(['backup', '--format', 'plain'], { DATABASE_URL: PG }).code, 0);
  const [file] = w.files();
  assert.match(file, /\.sql\.gz$/);
  assert.equal(gunzipSync(readFileSync(w.path('backups', file))).toString(), '-- fake sql\n');
});

test('backup: MySQL keeps the password out of the command line', () => {
  const w = workspace();
  const r = w.run(['backup', '--url', MY, '--dir', 'out']);
  assert.equal(r.code, 0, r.out);
  assert.match(w.files('out')[0], /^shop_.*\.sql\.gz$/);
  assert.match(w.log(), /cnf: \[client\] host="db\.example\.com" port=3307 user="app" password="p@ss\\"w" ssl-mode=REQUIRED/);
  const commandLines = w.log().split('\n').filter((l) => !l.startsWith('cnf:'));
  assert.ok(!commandLines.some((l) => l.includes('p@ss')));
});

test('backup: failure leaves nothing behind and pings /fail', async () => {
  const hits = [];
  const server = createServer((req, res) => { hits.push(req.url); res.end('ok'); }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/hc`;
  try {
    const w = workspace();
    const { spawn } = await import('node:child_process');
    // spawnSync would block the event loop, so the server couldn't answer the ping.
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['../bin/db-tools.mjs', 'backup', '--url', PG, '--dir', w.path('b'), '--ping', url], {
        cwd: new URL('.', import.meta.url).pathname,
        env: { ...process.env, PATH: `${new URL('./bin', import.meta.url).pathname}:${process.env.PATH}`, STUB_LOG: w.path('log'), FAIL_PG_DUMP: '1' },
        stdio: 'ignore',
      });
      p.on('close', resolve);
    });
    assert.equal(code, 1);
    assert.deepEqual(w.files('b'), []);
    assert.deepEqual(hits, ['/hc/fail']);
  } finally {
    server.close();
  }
});

test('backup: lock, retention and other names untouched', () => {
  const w = workspace();
  mkdirSync(w.path('backups', '.shop.lock'), { recursive: true });
  assert.match(w.run(['backup', '--url', PG]).out, /Another backup of shop is running/);
  w.run(['backup', '--url', PG]);
  // lock dir is someone else's, so it must still be there
  assert.ok(existsSync(w.path('backups', '.shop.lock')));

  const v = workspace();
  mkdirSync(v.path('backups'));
  for (const ts of ['20250101-000000', '20250102-000000', '20250103-000000']) writeFileSync(v.path('backups', `shop_${ts}.dump`), 'x');
  writeFileSync(v.path('backups', 'other_20250101-000000.dump'), 'x');
  assert.equal(v.run(['backup', '--url', PG, '--keep', '2']).code, 0);
  const shop = v.files().filter((f) => f.startsWith('shop_') && f.endsWith('.dump'));
  assert.equal(shop.length, 2);
  assert.ok(shop.includes('shop_20250103-000000.dump'));
  assert.ok(v.files().includes('other_20250101-000000.dump'));
  assert.ok(!v.files().some((f) => f.includes('.lock') || f.includes('partial')));
});

test('backup: S3 upload, S3 retention and --s3-only', () => {
  const w = workspace();
  const r = w.run(['backup', '--url', PG, '--s3', 's3://bkt/pg/', '--s3-endpoint', 'https://r2.example', '--s3-only', '--keep', '1']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^s3:\/\/bkt\/pg\/shop_.*\.dump$/m);
  assert.match(w.log(), /aws --endpoint-url https:\/\/r2\.example s3 cp/);
  assert.equal(w.files().filter((f) => f.endsWith('.dump')).length, 0);
  assert.equal(w.files('s3/bkt/pg').length, 2);   // dump + checksum

  const f = workspace();
  const failed = f.run(['backup', '--url', PG, '--s3', 's3://bkt/x'], { FAIL_AWS: '1' });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /local backup was kept/);
});

test('list and prune', () => {
  const w = workspace();
  mkdirSync(w.path('backups'));
  for (const ts of ['20250101-000000', '20250102-000000', '20250103-000000']) writeFileSync(w.path('backups', `shop_${ts}.dump`), 'x');
  const list = w.run(['list']);
  assert.match(list.stdout, /2025-01-01 00:00 UTC .* local .*shop_20250101-000000\.dump/);
  assert.equal(JSON.parse(w.run(['list', '--json']).stdout).length, 3);
  assert.equal(w.run(['prune']).code, 2);                     // which name? no terminal
  assert.equal(w.run(['prune', '--name', 'shop', '--keep', '1']).code, 0);
  assert.deepEqual(w.files(), ['shop_20250103-000000.dump']);
});

test('restore: confirmation, checksum, engine/extension match, S3', () => {
  const w = workspace();
  w.run(['backup', '--url', PG, '--s3', 's3://bkt/pg']);
  const dump = w.files().find((f) => f.endsWith('.dump'));
  const file = `backups/${dump}`;

  assert.equal(w.run(['restore', file, '--url', PG]).code, 2);         // no terminal to confirm
  const ok = w.run(['restore', file, '--url', PG, '--yes']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /checksum OK/);
  assert.match(w.log(), /pg_restore --clean --if-exists --no-owner --no-privileges -j 2 -d shop/);

  assert.match(w.run(['restore', file, '--url', MY, '--yes']).out, /can't be restored into MySQL/);
  assert.equal(w.run(['restore', 'nope.dump', '--url', PG, '--yes']).code, 2);

  const s3 = w.run(['restore', `s3://bkt/pg/${dump}`, '--url', PG, '--yes']);
  assert.equal(s3.code, 0, s3.out);
  assert.match(s3.out, /checksum OK/);

  appendFileSync(w.path(file), 'corrupt');
  assert.match(w.run(['restore', file, '--url', PG, '--yes']).out, /Checksum mismatch/);

  const failing = w.run(['restore', `s3://bkt/pg/${dump}`, '--url', PG, '--yes'], { FAIL_PG_RESTORE: '1' });
  assert.equal(failing.code, 1);
  assert.match(failing.out, /Restore finished with 1 error/);
});

test('restore: MySQL backup into MySQL', () => {
  const w = workspace();
  w.run(['backup', '--url', MY]);
  const r = w.run(['restore', `backups/${w.files()[0]}`, '--url', MY, '-y']);
  assert.equal(r.code, 0, r.out);
  assert.match(w.log(), /^mysql --defaults-extra-file=\S+ shop/m);
});

test('check shows server details', () => {
  const w = workspace();
  const pg = w.run(['check', '--url', PG, '--json']);
  assert.equal(pg.code, 0, pg.out);
  assert.equal(JSON.parse(pg.stdout).version, '17.2');
  const my = w.run(['check', '--url', MY]);
  assert.match(my.out, /Connected to app@db\.example\.com:3307\/shop/);
  assert.match(my.out, /2 tables/);
});

test('migrate refuses mixed engines and needs both URLs', () => {
  const w = workspace();
  const r = w.run(['migrate', '--from', PG, '--to', MY]);
  assert.equal(r.code, 1);
  assert.match(r.out, /can't copy PostgreSQL into MySQL/);
  assert.equal(w.run(['migrate', '--from', PG]).code, 2);
});
