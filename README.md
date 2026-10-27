# db-tools

[![CI](https://github.com/ym-scripts/db-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/ym-scripts/db-tools/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Back up, restore, migrate and inspect PostgreSQL and MySQL/MariaDB databases with one command.** The database type comes from the URL, so the same commands work for both.

```bash
npx github:ym-scripts/db-tools            # interactive menu
npx github:ym-scripts/db-tools backup --url "$DATABASE_URL" --keep 14 --s3 s3://my-bucket/db
npx github:ym-scripts/db-tools migrate --from "$OLD_URL" --to "$NEW_URL"
```

```text
? What do you want to do? (↑/↓, enter)
❯ backup   Back up a database to a local folder and, optionally, S3
  restore  Restore a backup (local file or s3:// URI) into a database
  migrate  Copy one database into another, with checks and verification
  list     List backups, oldest first
  prune    Delete old backups, keeping the newest N
  check    Test a connection and show server details
  shell    Open psql or mysql connected to the database
```

No npm dependencies. It uses your database's own client tools for dumps and Node for everything else (gzip, checksums, S3 calls, prompts).

## Requirements

- **Node.js 18.17+**
- The **client tools** for your database, **at least as new as the server**:

  | Database        | Tools                                               | macOS                                           | Debian/Ubuntu                                                                                     |
  | --------------- | --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
  | PostgreSQL      | `pg_dump`, `pg_restore`, `psql`                     | `brew install libpq && brew link --force libpq` | `apt install postgresql-client` ([PGDG](https://wiki.postgresql.org/wiki/Apt) for newer versions) |
  | MySQL / MariaDB | `mysqldump`, `mysql` (or `mariadb-dump`, `mariadb`) | `brew install mysql-client`                     | `apt install mysql-client` or `mariadb-client`                                                    |

- For S3: the [AWS CLI](https://aws.amazon.com/cli/) with credentials. It works with Cloudflare R2, Backblaze B2 and MinIO through `--s3-endpoint`.

## Database URLs

| Scheme                         | Engine          | Example                                              |
| ------------------------------ | --------------- | ---------------------------------------------------- |
| `postgres://`, `postgresql://` | PostgreSQL      | `postgres://user:pass@host:5432/app?sslmode=require` |
| `mysql://`, `mariadb://`       | MySQL / MariaDB | `mysql://user:pass@host:3306/app?ssl-mode=required`  |

URL-encode special characters in passwords (`@` → `%40`, `/` → `%2F`, `:` → `%3A`). When a URL is missing and you're in a terminal, you're asked for it as hidden input.

**Passwords never show up in the process list.** PostgreSQL tools get them through `PG*` environment variables. MySQL tools get them through a private (`chmod 600`) temporary option file, deleted on exit.

## Commands

Run `db-tools <command> --help` for every option.

### `backup`

```bash
db-tools backup --url "$DATABASE_URL"                                  # ./backups/app_20261027-020000.dump
db-tools backup --keep 14 --s3 s3://my-bucket/db --s3-endpoint https://<id>.r2.cloudflarestorage.com
db-tools backup --s3 s3://my-bucket/db --s3-only --ping https://hc-ping.com/<uuid>
```

| Option                               | Env var                           | Default       |                                                                                                         |
| ------------------------------------ | --------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `-u`, `--url`                        | `DATABASE_URL`                    |               | Database to back up                                                                                     |
| `-d`, `--dir`                        | `BACKUP_DIR`                      | `./backups`   | Local folder                                                                                            |
| `-k`, `--keep`                       | `BACKUP_KEEP`                     | `7`           | Keep the newest N (local and S3). `0` keeps everything.                                                 |
| `--name`                             |                                   | database name | File name prefix                                                                                        |
| `--s3`, `--s3-endpoint`, `--s3-only` | `BACKUP_S3`, `BACKUP_S3_ENDPOINT` |               | Upload to S3; optionally don't keep a local copy                                                        |
| `--ping`                             | `BACKUP_PING_URL`                 |               | Request the URL on success and `URL/fail` on failure ([Healthchecks.io](https://healthchecks.io) style) |
| `--format`                           |                                   | `custom`      | PostgreSQL: `custom` (`pg_dump -Fc`) or `plain` (`.sql.gz`)                                             |
| `--exclude-schema`                   |                                   |               | PostgreSQL: skip a schema (repeatable)                                                                  |

Every backup is:

- **checked** before it's kept. `pg_restore --list` must be able to read it, or the MySQL dump must end with `Dump completed`.
- **checksummed**: a `.sha256` file sits next to it, compatible with `sha256sum -c`.
- **written atomically**: it's only renamed to its final name once complete.
- **locked**, so overlapping cron runs can't collide.

MySQL dumps use `--single-transaction --quick --routines --triggers --no-tablespaces --hex-blob` with `utf8mb4`. This gives a consistent snapshot without locking InnoDB tables, and works without the `PROCESS` privilege that managed databases often don't grant.

The backup path is the only thing printed on stdout, so `file=$(db-tools backup -q …)` works.

### `restore`

```bash
db-tools restore                                              # pick from ./backups, interactively
db-tools restore ./backups/app_20261027-020000.dump --url "$TARGET_URL"
db-tools restore s3://my-bucket/db/app_20261027-020000.sql.gz --url "$TARGET_URL" --yes
```

The checksum is verified first. Then you type the target database name to confirm, unless you pass `--yes`. PostgreSQL `.dump` files are restored with `pg_restore --clean --if-exists --no-owner --no-privileges`. `.sql.gz` files are piped into `psql` or `mysql` and stop at the first error. PostgreSQL plain backups include `DROP … IF EXISTS` statements, and MySQL dumps drop each table before recreating it, so both replace existing objects.

### `migrate`

```bash
db-tools migrate                                              # asks for both URLs
db-tools migrate --from "$OLD_URL" --to "$NEW_URL" --dry-run   # checks only
db-tools migrate --from "$OLD_URL" --to "$NEW_URL" --yes --overwrite
```

This copies everything from one database into another of the same engine, for example from Neon to Aiven, local to RDS, or PlanetScale to a VPS.

1. **Pre-flight checks.**
   - Both engines: client tools, source ≠ target, both reachable, target empty, free disk space.
   - PostgreSQL also: pooled source connection, SSL, version compatibility, encoding and collation, extensions available on the target, target permissions, unreadable source tables, live writes on the source.
   - MySQL also: MySQL ↔ MariaDB and version compatibility, character set, SSL.
2. **A plan and a confirmation.** If the target already has tables, you type its name. With `--yes`, a non-empty target also needs `--overwrite`.
3. **Copy**: dump to a temporary file, then restore.
4. **Verify**: exact row counts for every table, sequence values (PostgreSQL), and counts of indexes, views, constraints, triggers and functions or routines. If verification fails, the dump is kept.

The source is only ever read. Copying between engines (PostgreSQL ↔ MySQL) isn't supported.

### `list`, `prune`, `check`, `shell`

```bash
db-tools list [--dir ./backups] [--s3 s3://…] [--json]
db-tools prune --name app --keep 7 [--s3 s3://…]
db-tools check --url "$DATABASE_URL"          # connect and show version, size, tables, encoding
db-tools shell --url "$DATABASE_URL"          # psql / mysql, already logged in
```

### Exit codes

| Code  | Meaning                                                                               |
| ----- | ------------------------------------------------------------------------------------- |
| `0`   | Success                                                                               |
| `1`   | The operation failed, verification found differences, or you cancelled a confirmation |
| `2`   | Usage or setup error (bad option or URL, missing tool, no terminal to ask on)         |
| `130` | Interrupted (Ctrl-C)                                                                  |

## Scheduling backups

**cron**, daily at 02:00:

```cron
0 2 * * * . /etc/db-tools.env && /usr/bin/npx -y github:ym-scripts/db-tools#v0.1.0 backup -q >> /var/log/db-backup.log 2>&1
```

`/etc/db-tools.env` (`chmod 600`):

```bash
export DATABASE_URL='postgres://…' BACKUP_DIR=/var/backups/db BACKUP_KEEP=14
export BACKUP_S3=s3://backups/db BACKUP_S3_ENDPOINT=https://<id>.r2.cloudflarestorage.com
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… BACKUP_PING_URL=https://hc-ping.com/<uuid>
```

**GitHub Actions:**

```yaml
on:
  schedule: [{ cron: "0 2 * * *" }]
  workflow_dispatch:
jobs:
  backup:
    runs-on: ubuntu-latest
    steps:
      - run: sudo apt-get install -y postgresql-client # or mysql-client
      - run: npx -y github:ym-scripts/db-tools#v0.1.0 backup --s3-only --keep 30
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          BACKUP_S3: s3://my-bucket/db
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_DEFAULT_REGION: us-east-1
```

**Laravel** (reuse your `.env`):

```bash
set -a; . ./.env; set +a
db-tools backup --url "mysql://$DB_USERNAME:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_DATABASE" --dir storage/backups
```

## Tips

- **Test your restores.** Restore into a scratch database every so often, for example with `db-tools restore … --url postgres://…/scratch`.
- Use the **direct** connection, not a pooler (PgBouncer, Neon's `-pooler` host), for `backup` and `migrate`.
- Stop writes before you `migrate`, and keep the old database for a few days.
- Backups contain all your data. Use a private, encrypted bucket.

## Project layout

```text
bin/db-tools.mjs        entry point
src/main.mjs            command dispatch and the interactive menu
src/commands/           one file per command (backup, restore, migrate, list, prune, check, shell)
src/engines/            postgres.mjs and mysql.mjs, behind one interface
src/lib/                URL parsing, process running, storage/S3, checksums, checks, cleanup
src/ui/                 output (colours, spinner) and prompts (select, hidden input, confirm)
src/cli/args.mjs        flag parser; help text is generated from each command's spec
```

To add an engine, implement the interface in `src/engines/postgres.mjs` and register its URL schemes in `src/lib/url.mjs`.

## Development

```bash
npm test                    # unit and CLI tests with fake pg_dump/psql/mysqldump/mysql/aws
PG_URL=… MYSQL_URL=… bash test/e2e.sh   # against real servers (what CI runs)
```

## License

[MIT](LICENSE) © Aghogho Meyoron
