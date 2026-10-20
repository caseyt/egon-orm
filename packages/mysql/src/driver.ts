/**
 * The driver wrapper over `mysql2`: a pool, statements with bound parameters (the
 * prepared-statement protocol), result streams, and `KILL QUERY` for cancellation.
 * Everything else (transactions, timeouts, telemetry, errors) is the shared adapter's.
 *
 * @module
 */
import type { createAdapter, PoolEvent, RawResult } from "egon-orm";
import mysql2 from "mysql2";
import type { Connection, ExecuteValues, Pool, PoolConnection, PoolOptions, ResultSetHeader } from "mysql2";
import type { PoolSettings } from "./options.js";

/** The driver interface of the shared adapter (not exported by name from `egon-orm`). */
type Definition = Parameters<typeof createAdapter>[0];
type DriverWrapper = ReturnType<Definition["driver"]>;
type DriverHooks = Parameters<Definition["driver"]>[0];
type DriverConnection = Awaited<ReturnType<DriverWrapper["acquire"]>>;
type DriverCursor = Awaited<ReturnType<DriverConnection["cursor"]>>;

/** What the wrapper creates its objects with. Replaced in unit tests, which have no database. */
export interface MysqlRuntime {
  /** Creates the pool the adapter owns. */
  readonly createPool: (config: PoolOptions) => Pool;
  /** Opens a connection of its own, for `KILL QUERY`. */
  readonly createConnection: (config: PoolOptions) => Connection;
}

/** The real runtime. */
export const MYSQL_RUNTIME: MysqlRuntime = {
  createPool: (config) => mysql2.createPool(config),
  createConnection: (config) => mysql2.createConnection(config),
};

/** The pool options that are not connection options, left out of the connection that sends `KILL QUERY`. */
const POOL_ONLY: ReadonlySet<string> = new Set([
  "connectionLimit",
  "waitForConnections",
  "queueLimit",
  "idleTimeout",
  "maxIdle",
  "enableKeepAlive",
  "keepAliveInitialDelay",
]);

/** The server's status flag for "inside a transaction" (SERVER_STATUS_IN_TRANS). */
const IN_TRANSACTION = 0x0001;

/** How long a `KILL QUERY` may take when the pool sets no `connectionTimeoutMs`. */
const DEFAULT_CANCEL_TIMEOUT_MS = 10_000;

/** `Rows matched: 3  Changed: 1  Warnings: 0`: what an `UPDATE` reports beside its changed rows. */
const ROWS_MATCHED = /^Rows matched: (\d+)/;

const EMPTY_ROWS: readonly Record<string, unknown>[] = Object.freeze([]);

/** Turns an `insertId` into the key the repo reads back: none when it is 0. */
function insertedKey(insertId: unknown): bigint | number | undefined {
  if (typeof insertId === "number") return insertId === 0 ? undefined : insertId;
  if (typeof insertId === "string" && /^\d+$/.test(insertId)) return BigInt(insertId);
  return undefined;
}

/** One checked-out `mysql2` connection. */
class MysqlConnection implements DriverConnection {
  /** The server's account of the transaction, from the status of the last OK packet. */
  private transaction = false;

  constructor(
    readonly connection: PoolConnection,
    private readonly driver: MysqlDriver,
  ) {}

  query(sql: string, params: readonly unknown[], _statementName: string | undefined): Promise<RawResult> {
    return new Promise((resolve, reject) => {
      const done = (error: unknown, result: unknown): void => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        resolve(this.result(result));
      };
      // Without values, the text protocol: it takes every statement (SAVEPOINT, DDL, …).
      // With values, a prepared statement: the values travel apart from the SQL text.
      if (params.length === 0) this.connection.query(sql, done);
      else this.connection.execute(sql, params as ExecuteValues[], done);
    });
  }

  private result(result: unknown): RawResult {
    if (Array.isArray(result)) {
      return { rows: result as Record<string, unknown>[], rowCount: result.length, insertId: undefined };
    }
    const header = result as ResultSetHeader;
    if (typeof header.serverStatus === "number") {
      this.transaction = (header.serverStatus & IN_TRANSACTION) !== 0;
    }
    // An UPDATE's affectedRows counts the rows it changed; the rows it matched are the
    // count the other databases report.
    const matched = typeof header.info === "string" ? ROWS_MATCHED.exec(header.info) : null;
    const rowCount = matched === null ? header.affectedRows : Number(matched[1]);
    return { rows: EMPTY_ROWS, rowCount, insertId: insertedKey(header.insertId) };
  }

  cursor(sql: string, params: readonly unknown[]): Promise<DriverCursor> {
    const command =
      params.length === 0
        ? this.connection.query(sql)
        : this.connection.execute(sql, params as ExecuteValues[]);
    return Promise.resolve(new MysqlCursor(this.connection, command));
  }

  cancel(): Promise<void> {
    return this.driver.cancel(this.connection.threadId);
  }

  inTransaction(): boolean {
    return this.transaction;
  }
}

/** The events a running `mysql2` command emits. */
interface Command {
  on(event: "result", listener: (row: Record<string, unknown>) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

/**
 * The rows of one statement as the server sends them, read a batch at a time. The socket
 * is paused while a batch is waiting to be read, so that rows are not buffered beyond it.
 * Closing early reads (and drops) the rest of the result, which keeps the connection usable.
 */
class MysqlCursor implements DriverCursor {
  private readonly buffer: Record<string, unknown>[] = [];
  private ended = false;
  private failure: Error | undefined = undefined;
  private wanted = 0;
  private wake: (() => void) | undefined = undefined;
  private dropping = false;

  constructor(
    private readonly connection: PoolConnection,
    command: Command,
  ) {
    command.on("result", (row) => {
      if (this.dropping) return;
      this.buffer.push(row);
      if (this.buffer.length >= this.wanted) {
        this.connection.pause();
        this.notify();
      }
    });
    command.on("error", (error) => {
      this.failure = error;
      this.ended = true;
      this.notify();
    });
    command.on("end", () => {
      this.ended = true;
      this.notify();
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async read(count: number): Promise<readonly Record<string, unknown>[]> {
    while (this.buffer.length < count && !this.ended) {
      this.wanted = count;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.connection.resume();
      });
    }
    if (this.buffer.length === 0 && this.failure !== undefined) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
    return this.buffer.splice(0, count);
  }

  async close(): Promise<void> {
    this.buffer.length = 0;
    if (this.ended) return;
    this.dropping = true;
    await new Promise<void>((resolve) => {
      this.wake = resolve;
      this.connection.resume();
    });
  }
}

/** The `mysql2` driver wrapper. */
export class MysqlDriver implements DriverWrapper {
  private pool: Pool | undefined = undefined;
  private readonly onConnection: (connection: PoolConnection) => void;

  constructor(
    private readonly settings: PoolSettings,
    private readonly hooks: DriverHooks,
    private readonly runtime: MysqlRuntime = MYSQL_RUNTIME,
  ) {
    this.onConnection = (connection) => this.adopt(connection);
  }

  init(): void {
    const pool = this.runtime.createPool(this.settings.config);
    pool.on("connection", this.onConnection);
    this.pool = pool;
  }

  /**
   * Prepares a new connection: its session is UTC, an error it reports between statements
   * (the server ended the session) is kept from ending the process, and its socket's close
   * is reported as a `disconnect`.
   */
  private adopt(connection: PoolConnection): void {
    connection.on("error", () => undefined);
    connection.query("set time_zone = '+00:00'", () => undefined);
    const stream = (connection as unknown as { stream?: { once(event: "close", listener: () => void): void } })
      .stream;
    stream?.once("close", () => this.hooks.disconnected());
    this.hooks.connected();
  }

  /**
   * Checks a connection out. With `connectionTimeoutMs`, a caller that waits longer for a
   * free connection is refused (mysql2 has no such limit of its own); a connection that
   * arrives afterwards goes straight back to the pool.
   */
  acquire(): Promise<DriverConnection> {
    const pool = this.started();
    const waitMs = this.settings.waitTimeoutMs;
    return new Promise((resolve, reject) => {
      let late = false;
      const timer =
        waitMs > 0
          ? setTimeout(() => {
              late = true;
              const error = new Error("Timed out waiting for a free connection from the pool.") as Error & {
                code: string;
              };
              error.code = "POOL_TIMEOUT";
              reject(error);
            }, waitMs)
          : undefined;
      pool.getConnection((error, connection) => {
        if (timer !== undefined) clearTimeout(timer);
        if (late) {
          if (error === null || error === undefined) connection.release();
          return;
        }
        if (error !== null && error !== undefined) reject(error);
        else resolve(new MysqlConnection(connection, this));
      });
    });
  }

  async release(connection: DriverConnection, destroy: boolean): Promise<void> {
    const checkedOut = (connection as MysqlConnection).connection;
    if (destroy) checkedOut.destroy();
    else checkedOut.release();
  }

  destroy(): Promise<void> {
    const pool = this.pool;
    if (pool === undefined) return Promise.resolve();
    pool.off("connection", this.onConnection);
    return new Promise((resolve, reject) => {
      pool.end((error) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve();
      });
    });
  }

  stats(): PoolEvent {
    const pool = this.started() as unknown as {
      readonly _allConnections?: { readonly length: number };
      readonly _freeConnections?: { readonly length: number };
      readonly _connectionQueue?: { readonly length: number };
    };
    return {
      size: pool._allConnections?.length ?? 0,
      idle: pool._freeConnections?.length ?? 0,
      waiting: pool._connectionQueue?.length ?? 0,
    };
  }

  saturated(): boolean {
    const { size, idle } = this.stats();
    return idle === 0 && size >= this.settings.max;
  }

  /**
   * Stops the statement that connection `threadId` is running, with `KILL QUERY` sent on a
   * connection of its own, which is closed afterwards. Resolves once the server has acted on
   * it. Bounded by the pool's `connectionTimeoutMs` (10 s when it has none).
   *
   * @throws Error when the connection has no thread id, or the kill fails or times out.
   */
  cancel(threadId: number | null): Promise<void> {
    if (typeof threadId !== "number") {
      return Promise.reject(new Error("The connection has no thread id to cancel its statement with."));
    }
    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.settings.config)) {
      if (!POOL_ONLY.has(key)) config[key] = value;
    }
    const timeoutMs = this.settings.waitTimeoutMs > 0 ? this.settings.waitTimeoutMs : DEFAULT_CANCEL_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      const killer = this.runtime.createConnection(config as PoolOptions);
      let settled = false;
      const finish = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killer.destroy();
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(
        () => finish(new Error(`The KILL QUERY got no answer within ${timeoutMs} ms.`)),
        timeoutMs,
      );
      killer.on("error", finish);
      // The thread id is a number the server gave; it is bound all the same.
      killer.execute("kill query ?", [threadId], (error) => finish(error ?? undefined));
    });
  }

  private started(): Pool {
    const pool = this.pool;
    if (pool === undefined) throw new Error("The mysql2 driver wrapper was used before init().");
    return pool;
  }
}
