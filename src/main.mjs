// Entry point: dispatches to a command, or shows an interactive menu when run with
// no arguments in a terminal.
import { readFileSync } from 'node:fs';
import './lib/cleanup.mjs';
import { parseArgs, helpFor } from './cli/args.mjs';
import { CliError, setQuiet, c } from './ui/output.mjs';
import { isInteractive, select } from './ui/prompts.mjs';
import backup from './commands/backup.mjs';
import restore from './commands/restore.mjs';
import list from './commands/list.mjs';
import prune from './commands/prune.mjs';
import migrate from './commands/migrate.mjs';
import check from './commands/check.mjs';
import shell from './commands/shell.mjs';

const BIN = process.env.DB_TOOLS_CMD || 'db-tools';
const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const COMMANDS = [backup, restore, migrate, list, prune, check, shell];
const byName = new Map(COMMANDS.map((cmd) => [cmd.name, cmd]));

function mainHelp() {
  const width = Math.max(...COMMANDS.map((cmd) => cmd.name.length)) + 4;
  return `${BIN} ${VERSION}: back up, restore, migrate and inspect PostgreSQL and MySQL/MariaDB databases.

Usage: ${BIN} <command> [options]
       ${BIN}                      interactive menu

Commands:
${COMMANDS.map((cmd) => `  ${cmd.name.padEnd(width)}${cmd.summary}`).join('\n')}

The database type comes from the URL scheme: postgres://, postgresql://, mysql://, mariadb://.
Run "${BIN} <command> --help" for a command's options.

Exit codes: 0 success, 1 the operation failed, 2 usage or setup error, 130 cancelled.`;
}

async function menu() {
  console.error(`${c.bold(BIN)} ${c.dim(VERSION)}\n`);
  const name = await select({
    message: 'What do you want to do?',
    choices: COMMANDS.map((cmd) => ({ value: cmd.name, label: cmd.name, hint: cmd.summary })),
  });
  return { cmd: byName.get(name), argv: [], guided: true };
}

export async function main(argv) {
  try {
    let cmd;
    let rest = argv.slice(1);
    let guided = false;
    const first = argv[0];

    if (first === undefined) {
      if (!isInteractive()) { console.log(mainHelp()); return; }
      ({ cmd, argv: rest, guided } = await menu());
    } else if (first === '-h' || first === '--help' || first === 'help') {
      console.log(argv[1] && byName.has(argv[1]) ? helpFor(byName.get(argv[1]), BIN) : mainHelp());
      return;
    } else if (first === '-v' || first === '--version') {
      console.log(VERSION);
      return;
    } else {
      cmd = byName.get(first);
      if (!cmd) throw new CliError(`Unknown command: ${first}. Run "${BIN} --help" for the list.`, 2);
    }

    const { opts, positionals } = parseArgs(rest, cmd.spec);
    if (opts.help) { console.log(helpFor(cmd, BIN)); return; }
    if (positionals.length && !cmd.usage?.includes('FILE')) throw new CliError(`Unexpected argument: ${positionals[0]}`, 2);
    setQuiet(opts.quiet);
    await cmd.run(opts, { positionals, guided });
  } catch (e) {
    if (!(e instanceof CliError)) {
      console.error(c.red(e.stack || e.message));
      process.exitCode = 1;
      return;
    }
    console.error(`${c.red('✖')} ${e.message}${e.code === 2 ? c.dim(`\n  See: ${BIN} --help`) : ''}`);
    process.exitCode = e.code;
  }
}
