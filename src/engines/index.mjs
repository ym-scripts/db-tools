// Picks the engine for a parsed connection (the URL scheme decides).
import postgres from './postgres.mjs';
import mysql from './mysql.mjs';

const engines = { postgres, mysql };

export const engineFor = (conn) => engines[conn.engine];

/** The engine that can restore a backup file, judged by its extension. */
export const enginesForFile = (file) => Object.values(engines).filter((e) => e.restoreExts.some((x) => file.endsWith(`.${x}`)));
