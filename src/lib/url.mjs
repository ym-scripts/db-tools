// Parses database URLs. The scheme decides the engine.
import { usageError } from '../ui/output.mjs';

const SCHEMES = {
  'postgres:': 'postgres',
  'postgresql:': 'postgres',
  'mysql:': 'mysql',
  'mariadb:': 'mysql',
};
const DEFAULT_PORT = { postgres: '5432', mysql: '3306' };

export const SUPPORTED = 'postgres://, postgresql://, mysql:// or mariadb://';

/** @returns {{engine, host, port, user, password, database, params}} */
export function parseDbUrl(raw, what = 'Database URL') {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw usageError(`${what} isn't a valid URL. Expected something like postgres://user:pass@host:5432/dbname`);
  }
  const engine = SCHEMES[url.protocol];
  if (!engine) throw usageError(`${what}: unsupported scheme "${url.protocol}//". Use ${SUPPORTED}.`);
  const decode = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  const database = decode(url.pathname.replace(/^\//, ''));
  if (!url.hostname || !database || database.includes('/')) throw usageError(`${what} needs a host and a database name, e.g. ${engine}://user:pass@host/dbname`);
  return {
    engine,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || DEFAULT_PORT[engine],
    user: decode(url.username),
    password: decode(url.password),
    database,
    params: Object.fromEntries(url.searchParams),
  };
}

/** user@host:port/db, never the password. */
export const label = (conn) => `${conn.user ? `${conn.user}@` : ''}${conn.host}:${conn.port}/${conn.database}`;

export const sameDatabase = (a, b) =>
  a.engine === b.engine && a.host === b.host && a.port === b.port && a.database === b.database;

export const isLocalHost = (host) => ['localhost', '127.0.0.1', '::1'].includes(host);
