// Pre-flight check runner: prints ✔ / ▲ / ✖ lines and keeps the results.
import { c, icon, log } from '../ui/output.mjs';

export function createChecks() {
  const results = [];
  return {
    results,
    /** fn returns { status: 'pass'|'warn', msg } or throws to fail. Returns false on failure. */
    async run(name, fn) {
      let r;
      try {
        r = (await fn()) ?? { status: 'pass' };
      } catch (e) {
        r = { status: 'fail', msg: e.message.split('\n')[0] };
      }
      results.push({ name, ...r });
      log(`  ${icon[r.status]} ${name}${r.msg ? c.dim(' — ') + r.msg : ''}`);
      return r.status !== 'fail';
    },
    skip(name, why) {
      results.push({ name, status: 'skip' });
      log(`  ${icon.skip} ${name}${c.dim(` — skipped: ${why}`)}`);
    },
    count: (status) => results.filter((r) => r.status === status).length,
    warnings: () => results.filter((r) => r.status === 'warn'),
  };
}

export const pass = (msg) => ({ status: 'pass', msg });
export const warnResult = (msg) => ({ status: 'warn', msg });
