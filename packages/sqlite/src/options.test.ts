import { describe, expect, test } from "vitest";
import { resolveOptions, type SqliteOptions } from "./options.js";

describe("resolveOptions", () => {
  test("turns foreign keys on by default, then runs the pragmas in order", () => {
    expect(resolveOptions({ filename: ":memory:" })).toEqual({
      filename: ":memory:",
      readonly: false,
      pragmas: ["pragma foreign_keys = ON"],
    });
    expect(
      resolveOptions({
        filename: "app.db",
        readonly: true,
        pragmas: { journal_mode: "WAL", busy_timeout: 5000, cache_size: -2000, recursive_triggers: true },
      }),
    ).toEqual({
      filename: "app.db",
      readonly: true,
      pragmas: [
        "pragma foreign_keys = ON",
        "pragma journal_mode = WAL",
        "pragma busy_timeout = 5000",
        "pragma cache_size = -2000",
        "pragma recursive_triggers = ON",
      ],
    });
  });

  test("leaves foreign keys to the options when they name them, in any case", () => {
    expect(resolveOptions({ filename: "a.db", pragmas: { FOREIGN_KEYS: false } }).pragmas).toEqual([
      "pragma FOREIGN_KEYS = OFF",
    ]);
  });

  test("an option given as undefined is left out", () => {
    expect(
      resolveOptions({
        filename: "a.db",
        readonly: undefined,
        pragmas: { journal_mode: undefined } as unknown as SqliteOptions["pragmas"],
        planCacheSize: undefined,
      }),
    ).toEqual({ filename: "a.db", readonly: false, pragmas: ["pragma foreign_keys = ON"] });
    expect(resolveOptions({ filename: "a.db", pragmas: undefined }).pragmas).toEqual([
      "pragma foreign_keys = ON",
    ]);
  });

  test.each([
    [undefined, /options must be a plain object/],
    [null, /options must be a plain object/],
    [[], /options must be a plain object/],
    [{ filename: "a.db", file: "b.db" }, /unknown option "file"/],
    [{}, /filename must be a non-empty string/],
    [{ filename: "" }, /filename must be a non-empty string/],
    [{ filename: "a\u0000b" }, /filename must be a non-empty string/],
    [{ filename: 3 }, /filename must be a non-empty string/],
    [{ filename: "a.db", readonly: "yes" }, /readonly must be a boolean/],
    [{ filename: "a.db", pragmas: [] }, /pragmas must be an object/],
    [{ filename: "a.db", pragmas: "journal_mode = WAL" }, /pragmas must be an object/],
    [{ filename: "a.db", pragmas: { "journal_mode; drop table users": "WAL" } }, /is not a plain name/],
    [
      { filename: "a.db", pragmas: { journal_mode: "WAL; drop table users" } },
      /must be a word, a number or a boolean/,
    ],
    [{ filename: "a.db", pragmas: { journal_mode: "'WAL'" } }, /must be a word/],
    [{ filename: "a.db", pragmas: { cache_size: Number.NaN } }, /must be a word/],
    [{ filename: "a.db", pragmas: { cache_size: {} } }, /must be a word/],
  ])("refuses %j", (options, message) => {
    expect(() => resolveOptions(options as unknown as SqliteOptions)).toThrow(TypeError);
    expect(() => resolveOptions(options as unknown as SqliteOptions)).toThrow(message);
  });

  test("accepts an object without a prototype", () => {
    const options = Object.assign(Object.create(null) as object, { filename: "a.db" }) as SqliteOptions;
    expect(resolveOptions(options).filename).toBe("a.db");
  });
});
