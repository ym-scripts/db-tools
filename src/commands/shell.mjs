import { opt, connection } from './shared.mjs';
import { runInteractive } from '../lib/exec.mjs';
import { label } from '../lib/url.mjs';
import { log, c } from '../ui/output.mjs';

export default {
  name: 'shell',
  summary: 'Open psql or mysql connected to the database',
  usage: 'shell [--url URL]',
  spec: { url: opt.url, help: opt.help },

  async run(o) {
    const { conn, engine } = await connection(o.url);
    engine.checkTools();
    const { cmd, args, env } = engine.shell(conn);
    log(c.dim(`Connecting to ${label(conn)} with ${cmd}…`));
    process.exitCode = await runInteractive(cmd, args, { env });
  },
};
