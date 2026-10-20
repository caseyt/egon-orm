import { describe, expect, test } from "vitest";
import { type MysqlOptions, resolveOptions } from "./options.js";

const FIXED = {
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: false,
  timezone: "Z",
  charset: "UTF8MB4_0900_AI_CI",
  multipleStatements: false,
  flags: ["-FOUND_ROWS"],
};

describe("resolveOptions", () => {
  test("with no options: ten connections, waiting for ever, UTC and utf8mb4", () => {
    expect(resolveOptions(undefined)).toEqual({
      config: { ...FIXED, connectionLimit: 10, maxIdle: 10, waitForConnections: true, queueLimit: 0 },
      max: 10,
      waitTimeoutMs: 0,
    });
  });

  test("passes the connection settings and the pool's", () => {
    const resolved = resolveOptions({
      connectionString: "mysql://u:p@db:3306/app",
      host: "db2",
      port: 3307,
      user: "u2",
      password: "p2",
      database: "app2",
      ssl: { rejectUnauthorized: true },
      pool: { max: 3, idleTimeoutMs: 1000, connectionTimeoutMs: 250 },
      planCacheSize: 5,
    });
    expect(resolved).toEqual({
      config: {
        ...FIXED,
        uri: "mysql://u:p@db:3306/app",
        host: "db2",
        port: 3307,
        user: "u2",
        password: "p2",
        database: "app2",
        ssl: { rejectUnauthorized: true },
        connectionLimit: 3,
        maxIdle: 3,
        idleTimeout: 1000,
        connectTimeout: 250,
        waitForConnections: true,
        queueLimit: 0,
      },
      max: 3,
      waitTimeoutMs: 250,
    });
  });

  test("an ssl profile name is passed as it is; a connection timeout of 0 waits for ever", () => {
    const resolved = resolveOptions({ ssl: "Amazon RDS", pool: { connectionTimeoutMs: 0 } });
    expect(resolved.config.ssl).toBe("Amazon RDS");
    expect(resolved.waitTimeoutMs).toBe(0);
    expect(resolved.config.connectTimeout).toBeUndefined();
  });

  test("options given as undefined are left out", () => {
    expect(
      resolveOptions({ host: undefined, pool: { max: undefined, idleTimeoutMs: undefined } }).config,
    ).toEqual({ ...FIXED, connectionLimit: 10, maxIdle: 10, waitForConnections: true, queueLimit: 0 });
  });

  test("accepts an object without a prototype", () => {
    const options = Object.assign(Object.create(null) as object, { host: "db" }) as MysqlOptions;
    expect(resolveOptions(options).config.host).toBe("db");
  });

  test.each([
    [[], /options must be a plain object/],
    [{ hostname: "db" }, /unknown option "hostname"\. The options are/],
    [{ host: 1 }, /host must be a string/],
    [{ connectionString: {} }, /connectionString must be a string/],
    [{ port: 0 }, /port must be a whole number from 1 to 65535/],
    [{ port: 1.5 }, /port must be a whole number/],
    [{ port: "3306" }, /port must be a whole number/],
    [{ ssl: true }, /ssl must be a profile name or an object/],
    [{ pool: 5 }, /pool must be pool settings/],
    [{ pool: { size: 5 } }, /unknown option "size" in pool/],
    [{ pool: { max: 0 } }, /pool\.max must be a whole number from 1/],
    [{ pool: { idleTimeoutMs: -1 } }, /pool\.idleTimeoutMs/],
    [{ pool: { connectionTimeoutMs: 2 ** 31 } }, /pool\.connectionTimeoutMs/],
  ])("refuses %j", (options, message) => {
    expect(() => resolveOptions(options as unknown as MysqlOptions)).toThrow(TypeError);
    expect(() => resolveOptions(options as unknown as MysqlOptions)).toThrow(message);
  });
});
