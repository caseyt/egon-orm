/**
 * The options of `mysql(...)`, checked, and the `mysql2` pool configuration made from them.
 *
 * @module
 */
import type { PoolOptions, SslOptions } from "mysql2";

/**
 * Pool settings for the pool the adapter creates.
 *
 * @example
 * ```ts
 * const pool: MysqlPoolOptions = { max: 20, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 };
 * ```
 */
export interface MysqlPoolOptions {
  /** The most connections the pool opens. Default 10. */
  readonly max?: number | undefined;
  /** How long an unused connection stays open, in milliseconds. Default 60,000. */
  readonly idleTimeoutMs?: number | undefined;
  /**
   * How long to wait for a connection, in milliseconds, both to open a new one and for a
   * busy pool to free one; `0` waits forever. Default `0` (opening a connection is bounded
   * by the driver's own 10 seconds).
   */
  readonly connectionTimeoutMs?: number | undefined;
}

/**
 * The options of {@link mysql}. Every option may also be given as `undefined`, which is the
 * same as leaving it out (`connectionString: process.env.DATABASE_URL`).
 *
 * Connect with `connectionString`, or with `host`, `port`, `user`, `password`, `database`
 * and `ssl`, or both (the separate settings win). There is no time zone option: the
 * session is always UTC.
 *
 * @example
 * ```ts
 * const options: MysqlOptions = {
 *   connectionString: process.env.DATABASE_URL,
 *   pool: { max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
 * };
 * ```
 */
export interface MysqlOptions {
  /** A `mysql://` URL. */
  readonly connectionString?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  readonly database?: string | undefined;
  /** TLS options for `node:tls`, or a profile name `mysql2` knows. */
  readonly ssl?: string | SslOptions | undefined;
  /** Settings for the pool the adapter creates. */
  readonly pool?: MysqlPoolOptions | undefined;
  /** How many compiled query shapes the adapter keeps. Default 1,000. */
  readonly planCacheSize?: number | undefined;
}

/** What the driver needs: the pool configuration, and how long to wait for a connection. */
export interface PoolSettings {
  readonly config: PoolOptions;
  /** The most connections; what `saturated()` compares with. */
  readonly max: number;
  /** How long a caller waits for a free connection; `0` for ever. */
  readonly waitTimeoutMs: number;
}

const OPTION_KEYS: ReadonlySet<string> = new Set([
  "connectionString",
  "host",
  "port",
  "user",
  "password",
  "database",
  "ssl",
  "pool",
  "planCacheSize",
]);

const POOL_KEYS: ReadonlySet<string> = new Set(["max", "idleTimeoutMs", "connectionTimeoutMs"]);

const MAX_MS = 2_147_483_647;

function fail(message: string): never {
  throw new TypeError(`mysql(options): ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkUnknown(value: Record<string, unknown>, known: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      fail(`unknown option ${JSON.stringify(key)}${where}. The options are: ${[...known].join(", ")}.`);
    }
  }
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  return fail(`${name} must be a string.`);
}

function optionalCount(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return fail(`${name} must be a whole number from ${min} to ${max}, but it is ${String(value)}.`);
  }
  return value;
}

/**
 * The settings every connection of the adapter is opened with: values the codecs expect
 * (dates and big numbers as text, JSON parsed), UTC, utf8mb4, one statement per call, and
 * `affectedRows` counting the rows changed (an upsert that met an existing row and changed
 * nothing reports 0; for an `UPDATE` the driver wrapper reads the rows matched instead).
 */
const FIXED: PoolOptions = {
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: false,
  timezone: "Z",
  charset: "UTF8MB4_UNICODE_CI",
  multipleStatements: false,
  flags: ["-FOUND_ROWS"],
};

/**
 * Checks the options and builds the pool configuration.
 *
 * @throws TypeError for an unknown option, or a value of the wrong type or range.
 */
export function resolveOptions(options: MysqlOptions | undefined): PoolSettings {
  const given = options ?? {};
  if (!isPlainObject(given)) fail("options must be a plain object.");
  checkUnknown(given, OPTION_KEYS, "");
  const config: PoolOptions = { ...FIXED, connectionLimit: 10, waitForConnections: true, queueLimit: 0 };
  const connectionString = optionalString(given.connectionString, "connectionString");
  if (connectionString !== undefined) config.uri = connectionString;
  const host = optionalString(given.host, "host");
  if (host !== undefined) config.host = host;
  const port = optionalCount(given.port, "port", 1, 65_535);
  if (port !== undefined) config.port = port;
  const user = optionalString(given.user, "user");
  if (user !== undefined) config.user = user;
  const password = optionalString(given.password, "password");
  if (password !== undefined) config.password = password;
  const database = optionalString(given.database, "database");
  if (database !== undefined) config.database = database;
  const ssl: unknown = given.ssl;
  if (ssl !== undefined) {
    if (typeof ssl !== "string" && !isPlainObject(ssl)) fail("ssl must be a profile name or an object of TLS options.");
    config.ssl = ssl as string | SslOptions;
  }
  let max = 10;
  let waitTimeoutMs = 0;
  const pool: unknown = given.pool;
  if (pool !== undefined) {
    if (!isPlainObject(pool)) fail("pool must be pool settings ({ max, idleTimeoutMs, connectionTimeoutMs }).");
    checkUnknown(pool, POOL_KEYS, " in pool");
    const poolMax = optionalCount(pool.max, "pool.max", 1, 100_000);
    if (poolMax !== undefined) max = poolMax;
    const idle = optionalCount(pool.idleTimeoutMs, "pool.idleTimeoutMs", 0, MAX_MS);
    if (idle !== undefined) config.idleTimeout = idle;
    const connect = optionalCount(pool.connectionTimeoutMs, "pool.connectionTimeoutMs", 0, MAX_MS);
    if (connect !== undefined && connect > 0) {
      config.connectTimeout = connect;
      waitTimeoutMs = connect;
    }
  }
  config.connectionLimit = max;
  // The pool keeps up to `max` idle connections (mysql2's own default would be its limit too).
  config.maxIdle = max;
  return { config, max, waitTimeoutMs };
}
