// A small declarative flag parser. Each command declares a spec:
//   { url: { short: 'u', type: 'string', env: 'DATABASE_URL', desc: '…', default: … } }
// Precedence: command-line flag > environment variable > default.
import { usageError } from '../ui/output.mjs';

const kebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

function toNumber(value, flag) {
  if (!/^\d+$/.test(String(value))) throw usageError(`${flag} must be a whole number`);
  return Number(value);
}

export function parseArgs(argv, spec) {
  const flags = new Map();
  for (const [key, s] of Object.entries(spec)) {
    flags.set(`--${kebab(key)}`, [key, s]);
    if (s.short) flags.set(`-${s.short}`, [key, s]);
  }

  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); continue; }
    if (arg.startsWith('--') && arg.includes('=')) {
      inline = arg.slice(arg.indexOf('=') + 1);
      arg = arg.slice(0, arg.indexOf('='));
    }
    const hit = flags.get(arg);
    if (!hit) throw usageError(`Unknown option: ${arg}`);
    const [key, s] = hit;
    if (s.type === 'boolean') {
      if (inline !== undefined) throw usageError(`${arg} doesn't take a value`);
      opts[key] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && /^-./.test(value))) throw usageError(`${arg} needs a value`);
    const parsed = s.type === 'number' ? toNumber(value, arg) : value;
    if (s.choices && !s.choices.includes(parsed)) throw usageError(`${arg} must be one of: ${s.choices.join(', ')}`);
    if (s.multiple) (opts[key] ??= []).push(parsed);
    else opts[key] = parsed;
  }

  for (const [key, s] of Object.entries(spec)) {
    const fromEnv = s.env ? process.env[s.env] : undefined;
    if (opts[key] === undefined && fromEnv) opts[key] = s.type === 'number' ? toNumber(fromEnv, s.env) : fromEnv;
    if (opts[key] === undefined && s.default !== undefined) opts[key] = s.default;
  }
  return { opts, positionals };
}

/** Help text generated from a command's spec. */
export function helpFor(cmd, bin = 'db-tools') {
  const rows = Object.entries(cmd.spec).map(([key, s]) => {
    const flag = `${s.short ? `-${s.short}, ` : '    '}--${kebab(key)}${s.type === 'boolean' ? '' : ` ${s.arg ?? 'VALUE'}`}`;
    const extra = [s.env && `[${s.env}]`, s.default !== undefined && s.default !== false && `default: ${s.default}`].filter(Boolean).join('  ');
    return [flag, `${s.desc ?? ''}${extra ? `  ${extra}` : ''}`];
  });
  const width = Math.max(...rows.map(([f]) => f.length)) + 2;
  return [
    `${bin} ${cmd.name}: ${cmd.summary}`,
    '',
    `Usage: ${bin} ${cmd.usage ?? `${cmd.name} [options]`}`,
    '',
    'Options:',
    ...rows.map(([f, d]) => `  ${f.padEnd(width)}${d}`),
    ...(cmd.examples ? ['', 'Examples:', ...cmd.examples.map((e) => `  ${bin} ${e}`)] : []),
  ].join('\n');
}
