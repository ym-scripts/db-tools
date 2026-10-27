# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-10-27

First release. It replaces `pg-migrate` and the unreleased `pg-backup` and `mysql-backup`.

### Added

- One CLI for PostgreSQL and MySQL/MariaDB. The engine is picked from the URL scheme (`postgres://`, `postgresql://`, `mysql://`, `mariadb://`).
- `backup`: local and S3-compatible storage, retention, SHA-256 checksums, atomic writes, locking, health-check pings.
- `restore`: from a local file or `s3://`, with checksum verification and confirmation by typing the database name.
- `migrate`: pre-flight checks, a plan, confirmation, copy, then verification of exact row counts, sequences and object counts.
- `list`, `prune`, `check` (connection test and server details) and `shell` (`psql`/`mysql` with the URL's credentials).
- Interactive menu when run with no arguments. Missing values are asked for, and URLs are entered as hidden input.
- Passwords never appear in the process list: `PG*` environment variables for PostgreSQL, a private option file for MySQL.
