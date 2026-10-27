import { opt, connection } from './shared.mjs';
import { label } from '../lib/url.mjs';
import { log, c, icon, fmtBytes } from '../ui/output.mjs';

export default {
  name: 'check',
  summary: 'Test a connection and show server details',
  usage: 'check [--url URL]',
  spec: { url: opt.url, json: { type: 'boolean', desc: 'JSON output' }, help: opt.help },

  async run(o) {
    const { conn, engine } = await connection(o.url);
    const tools = engine.checkTools();
    const info = await engine.info(conn);
    if (o.json) return console.log(JSON.stringify({ engine: conn.engine, target: label(conn), client: tools.summary, ...info }, null, 2));
    log(`${icon.pass} Connected to ${c.bold(label(conn))}`);
    log(`  ${c.dim('server   ')} ${engine.name} ${info.version}`);
    log(`  ${c.dim('client   ')} ${tools.summary}`);
    log(`  ${c.dim('size     ')} ${fmtBytes(info.size)} · ${info.tables} tables`);
    log(`  ${c.dim('encoding ')} ${info.encoding}, ${info.collate}`);
  },
};
