// Synchronous cleanup that runs however the process ends (normal exit, error, Ctrl-C).
const tasks = new Set();

export function onExit(fn) {
  tasks.add(fn);
  return () => tasks.delete(fn);
}

function runAll() {
  for (const fn of tasks) {
    try { fn(); } catch { /* best effort */ }
  }
  tasks.clear();
}

process.on('exit', runAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    process.stderr.write('\nAborted.\n');
    process.exit(130);
  });
}
