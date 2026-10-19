// Unit tests for the repo's option handling: the log line, standard error, the named
// parameters of a query that is not a builder query, and how a call's arguments split.
import { Post, User } from "@egon-orm/test-support";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { QueryAst } from "../contracts/query.js";
import { from } from "../query/builder.js";
import { param } from "../query/functions.js";
import { t } from "../schema/index.js";
import {
  checkReadOptions,
  formatLogLine,
  namedParamsOf,
  READ_OPTION_KEYS,
  type RepoQueryEvent,
  splitArgs,
  writeToStderr,
} from "./options.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function event(overrides: Partial<RepoQueryEvent> = {}): RepoQueryEvent {
  return {
    sql: "select 1",
    paramCount: 0,
    durationMs: 1.234,
    queueMs: 0.5,
    rowCount: 1,
    error: undefined,
    params: undefined,
    context: undefined,
    operation: "all",
    source: "users",
    decodeMs: 0.01,
    ...overrides,
  };
}

describe("the log line", () => {
  test("names the operation, the table, the timings, the rows and the SQL", () => {
    expect(formatLogLine(event(), false)).toBe(
      "egon all users 1.23 ms (queue 0.50 ms, decode 0.01 ms) 1 row: select 1",
    );
    expect(formatLogLine(event({ rowCount: 3, source: undefined, operation: "raw" }), false)).toBe(
      "egon raw 1.23 ms (queue 0.50 ms, decode 0.01 ms) 3 rows: select 1",
    );
  });

  test("shows parameters only when asked to, each in a readable form", () => {
    const params = [
      "it's",
      12n,
      new Date("2026-01-01T00:00:00.000Z"),
      new Date(Number.NaN),
      new Uint8Array(3),
      { a: 1 },
      [1, "x"],
      null,
      undefined,
      true,
      2.5,
      "**redacted**",
    ];
    const line = formatLogLine(event({ params }), true);
    expect(line).toBe(
      'egon all users 1.23 ms (queue 0.50 ms, decode 0.01 ms) 1 row: select 1 -- params: ["it\'s", 12n, 2026-01-01T00:00:00.000Z, Invalid Date, <3 bytes>, {"a":1}, [1,"x"], null, undefined, true, 2.5, "**redacted**"]',
    );
    expect(formatLogLine(event({ params }), false)).not.toContain("params");
    expect(formatLogLine(event({ params: undefined }), true)).not.toContain("params");
  });

  test("a parameter that cannot be written as JSON is described", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cyclicList: unknown[] = [];
    cyclicList.push(cyclicList);
    const line = formatLogLine(event({ params: [cyclic, cyclicList, { toJSON: () => undefined }] }), true);
    expect(line).toMatch(/params: \[\[object\], \[array\], \[object Object\]\]$/);
  });

  test("a failed statement says so, with the error", () => {
    expect(formatLogLine(event({ error: new TypeError("bad") }), false)).toMatch(
      / failed: select 1 -- error: TypeError: bad$/,
    );
    expect(formatLogLine(event({ error: "plain" }), false)).toMatch(/ -- error: plain$/);
  });
});

describe("standard error", () => {
  test("a line goes to process.stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeToStderr("hello");
    expect(write).toHaveBeenCalledWith("hello\n");
  });

  test("without a process, the line is dropped", () => {
    vi.stubGlobal("process", undefined);
    expect(() => writeToStderr("hello")).not.toThrow();
  });
});

describe("named parameters of a query", () => {
  test("a builder query lists its own", () => {
    const q = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    expect(namedParamsOf(q)).toEqual(["minAge"]);
  });

  test("a bare AST is walked once, preload callbacks included", () => {
    const base = from(User, "u").where(({ u }) =>
      u.age.gte(param("minAge", t.integer())).and(u.age.lte(param("minAge", t.integer()))),
    ).ast;
    const posts = from(Post, "posts").where(({ posts }) => posts.views.gte(param("views", t.integer()))).ast;
    const comments = from(Post, "c").where(({ c }) => c.title.eq(param("title", t.string()))).ast;
    const ast: QueryAst = {
      ...base,
      preloads: [
        {
          kind: "preload",
          assoc: "posts",
          from: undefined,
          query: posts,
          nested: [{ kind: "preload", assoc: "comments", from: undefined, query: comments, nested: [] }],
        },
        { kind: "preload", assoc: "profile", from: undefined, query: undefined, nested: [] },
      ],
    };
    const queryable = { ast };
    const names = namedParamsOf(queryable);
    expect(names).toEqual(["minAge", "views", "title"]);
    expect(namedParamsOf({ ast })).toBe(names);
  });
});

describe("splitting a call's arguments", () => {
  test("without named parameters: the options", () => {
    expect(splitArgs("all", [], [], READ_OPTION_KEYS)).toEqual({ named: undefined, options: undefined });
    expect(splitArgs("all", [], [{ timeoutMs: 1 }], READ_OPTION_KEYS)).toEqual({
      named: undefined,
      options: { timeoutMs: 1 },
    });
  });

  test("with named parameters: the parameters, then the options", () => {
    expect(splitArgs("all", ["a"], [{ a: 1 }], READ_OPTION_KEYS)).toEqual({
      named: { a: 1 },
      options: undefined,
    });
    expect(splitArgs("all", ["a", "b"], [{ a: 1 }, { schema: "s" }], READ_OPTION_KEYS)).toEqual({
      named: { a: 1 },
      options: { schema: "s" },
    });
    expect(() => splitArgs("all", ["a", "b"], [undefined], READ_OPTION_KEYS)).toThrow(
      /named parameters "a", "b"/,
    );
  });

  test("options must be a plain object of known keys", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.timeoutMs = 5;
    expect(checkReadOptions("all", bare, READ_OPTION_KEYS)).toBe(bare);
    expect(() => checkReadOptions("all", Object.create({ timeoutMs: 1 }), READ_OPTION_KEYS)).toThrow(
      TypeError,
    );
    expect(() => checkReadOptions("all", new Date(), READ_OPTION_KEYS)).toThrow(TypeError);
    expect(() => checkReadOptions("all", null, READ_OPTION_KEYS)).toThrow(/null/);
  });
});
