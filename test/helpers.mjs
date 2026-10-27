import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'db-tools.mjs');

export const PG = 'postgres://app:p%40ss%2Fw@db.example.com:6543/shop?sslmode=require';
export const MY = 'mysql://app:p%40ss%22w@db.example.com:3307/shop?ssl-mode=required';

export function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'db-tools-test-'));
  return {
    dir,
    path: (...p) => join(dir, ...p),
    files: (sub = 'backups') => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).sort() : []),
    log: () => (existsSync(join(dir, 'log')) ? readFileSync(join(dir, 'log'), 'utf8') : ''),
    run(args, env = {}) {
      const r = spawnSync(process.execPath, [BIN, ...args], {
        cwd: dir,
        encoding: 'utf8',
        input: '',
        env: {
          PATH: join(here, 'bin') + delimiter + process.env.PATH,
          HOME: dir,
          NO_COLOR: '1',
          STUB_LOG: join(dir, 'log'),
          FAKE_S3: join(dir, 's3'),
          ...env,
        },
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: r.stdout + r.stderr };
    },
  };
}
