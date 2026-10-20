import { createConnection } from "mysql2/promise";
import pg from "pg";
import { parseDatabaseName, unreachable } from "./db.js";
import { type ConnectionSettings, connectionSettings, type Dialect } from "./env.js";

/** Which test databases {@link sweepTestDatabases} drops. A database matching either rule is dropped. */
export interface SweepOptions {
  /** Drop every database created by this run, whatever its age. */
  readonly runId?: string;
  /**
   * Drop databases of any run whose name is older than this many milliseconds. Such a
   * database was leaked by a run that was killed; a live run's databases are younger. A
   * database with open connections is never treated as stale.
   */
  readonly olderThanMs?: number;
  /** Connection settings for the server. Default: `connectionSettings(dialect)`. */
  readonly settings?: ConnectionSettings;
  /** Restricts the sweep to names matching this pattern; for tests. */
  readonly only?: RegExp;
  /** The current time; for tests. */
  readonly now?: Date;
}

/** True when `name` is a test database that `options` says should be dropped. */
export function shouldSweep(name: string, options: SweepOptions): boolean {
  const parsed = parseDatabaseName(name);
  if (parsed === undefined) return false;
  if (options.only !== undefined && !options.only.test(name)) return false;
  if (options.runId !== undefined && parsed.runId === options.runId) return true;
  if (options.olderThanMs === undefined) return false;
  const age = (options.now ?? new Date()).getTime() - parsed.createdAt.getTime();
  return age > options.olderThanMs;
}

async function sweepPostgres(server: ConnectionSettings, options: SweepOptions): Promise<string[]> {
  const client = new pg.Client(server);
  try {
    await client.connect();
  } catch (cause) {
    throw unreachable("postgres", server, cause);
  }
  try {
    const { rows } = await client.query<{ name: string; connections: number }>(
      `SELECT d.datname AS name, count(a.pid)::int AS connections
         FROM pg_database d LEFT JOIN pg_stat_activity a ON a.datid = d.oid
        WHERE d.datname LIKE 'egon\\_%' GROUP BY d.datname ORDER BY d.datname`,
    );
    const dropped: string[] = [];
    for (const { name, connections } of rows) {
      const parsed = parseDatabaseName(name);
      if (parsed === undefined || !shouldSweep(name, options)) continue;
      // A database another run is connected to is in use, however old its name is.
      if (parsed.runId !== options.runId && connections > 0) continue;
      // Names that parse are [a-z0-9_] only, so they need no quoting.
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      dropped.push(name);
    }
    return dropped;
  } finally {
    await client.end();
  }
}

async function sweepMysql(server: ConnectionSettings, options: SweepOptions): Promise<string[]> {
  let connection: Awaited<ReturnType<typeof createConnection>>;
  try {
    connection = await createConnection(server);
  } catch (cause) {
    throw unreachable("mysql", server, cause);
  }
  try {
    const [rows] = await connection.query(
      `SELECT s.schema_name AS name, COUNT(p.id) AS connections
         FROM information_schema.schemata s LEFT JOIN information_schema.processlist p ON p.db = s.schema_name
        WHERE s.schema_name LIKE 'egon\\\\_%' GROUP BY s.schema_name ORDER BY s.schema_name`,
    );
    const dropped: string[] = [];
    for (const { name, connections } of rows as { name: string; connections: number | string }[]) {
      const parsed = parseDatabaseName(name);
      if (parsed === undefined || !shouldSweep(name, options)) continue;
      // A database another run is connected to is in use, however old its name is.
      if (parsed.runId !== options.runId && Number(connections) > 0) continue;
      await connection.query(`DROP DATABASE IF EXISTS ${name}`);
      dropped.push(name);
    }
    return dropped;
  } finally {
    await connection.end();
  }
}

/**
 * Drops leaked test databases on the `dialect` server and returns their names.
 *
 * `withDatabase` cleans up after itself, but nothing can clean up after a process that was
 * killed (Ctrl-C, a cancelled CI job, a crashed worker). `global-setup.ts` therefore sweeps
 * stale databases before an integration run and this run's databases after it.
 *
 * Only names produced by `uniqueDatabaseName` are ever touched. Two runs can share one
 * server: a run drops another run's database only when it is older than `olderThanMs`
 * and has no open connections.
 */
export function sweepTestDatabases(dialect: Dialect, options: SweepOptions): Promise<string[]> {
  // A SQLite test database is a file in a directory of its own, removed with it; a killed
  // run leaves it in the system's temporary directory, which the system cleans.
  if (dialect === "sqlite") return Promise.resolve([]);
  const server = options.settings ?? connectionSettings(dialect);
  return dialect === "postgres" ? sweepPostgres(server, options) : sweepMysql(server, options);
}
