#!/usr/bin/env bash
# End-to-end test against real servers (used in CI).
# Needs PG_URL and MYSQL_URL pointing at empty, disposable databases named "shop",
# on servers where the user can create a second database "shop_copy".
set -euo pipefail
cd "$(dirname "$0")/.."
db() { node bin/db-tools.mjs "$@"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
copy_url() { echo "${1%/shop}/shop_copy"; }

: "${PG_URL:?}" "${MYSQL_URL:?}"
PG_COPY=$(copy_url "$PG_URL")
MY_COPY=$(copy_url "$MYSQL_URL")
pg() { psql -X -At "$1" -c "$2"; }
my() { MYSQL_PWD=pw mysql -h 127.0.0.1 -u root -N -B "$1" -e "$2"; }

step "seed"
pg "$PG_URL" "create schema app; create table app.users (id serial primary key, email text unique);
  insert into app.users (email) select 'u' || g || '@x.test' from generate_series(1, 500) g;
  create table notes (id bigserial primary key, user_id int references app.users(id), body text);
  insert into notes (user_id, body) select (g % 500) + 1, md5(g::text) from generate_series(1, 2000) g;
  create view app.counts as select user_id, count(*) from notes group by 1;"
pg "$PG_URL" "create database shop_copy"
my shop "create table t (id int primary key, body text);
  insert into t with recursive s(n) as (select 1 union all select n + 1 from s where n < 1000) select n, md5(n) from s;
  create view v as select count(*) c from t;"
my shop "create database shop_copy"

for url in "$PG_URL" "$MYSQL_URL"; do
    step "check $url"
    db check --url "$url"

    step "backup → drop → restore"
    file=$(db backup --url "$url" --dir ./e2e-backups --keep 0 -q)
    db list --dir ./e2e-backups
    case "$url" in
        postgres*) pg "$url" "drop view app.counts; drop table notes; drop table app.users" ;;
        *) my shop "drop view v; drop table t" ;;
    esac
    db restore "$file" --url "$url" --yes
    case "$url" in
        postgres*) test "$(pg "$url" 'select count(*) from notes')" = 2000 ;;
        *) test "$(my shop 'select count(*) from t')" = 1000 ;;
    esac
done

step "postgres plain backup round trip"
file=$(db backup --url "$PG_URL" --dir ./e2e-backups --format plain -q)
pg "$PG_URL" "drop view app.counts; drop table notes"
db restore "$file" --url "$PG_URL" --yes
test "$(pg "$PG_URL" 'select count(*) from notes')" = 2000

for pair in "$PG_URL $PG_COPY" "$MYSQL_URL $MY_COPY"; do
    set -- $pair
    step "migrate $1 → $2"
    db migrate --from "$1" --to "$2" --dry-run
    db migrate --from "$1" --to "$2" --yes
    if db migrate --from "$1" --to "$2" --yes; then echo "expected refusal: target not empty" >&2; exit 1; fi
    db migrate --from "$1" --to "$2" --yes --overwrite
done
test "$(pg "$PG_COPY" 'select count(*) from app.users')" = 500
test "$(my shop_copy 'select count(*) from t')" = 1000

printf '\n\033[32mAll e2e tests passed.\033[0m\n'
