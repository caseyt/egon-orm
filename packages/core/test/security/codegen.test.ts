// The security review of step 21: code generation. Three places make functions from
// source text with `new Function` (through internal/codegen.ts): the row factories of a
// schema, the value builders of validate(), and the row decoders of a query. These tests
// check that `codegen: false` keeps an application that uses all three from ever calling
// `new Function`, and that the generated source holds no text a schema, a query or the
// data could turn into code: names go in as string literals, everything else is a counter.
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DriverConnection, DriverCursor, DriverWrapper } from "../../src/adapter/driver.js";
import type { PoolEvent, RawResult } from "../../src/contracts/adapter.js";
import type { AnySchema } from "../../src/contracts/schema.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Counts `new Function` calls from now on (and still makes the functions). */
function countGeneration(): () => number {
  let calls = 0;
  vi.stubGlobal(
    "Function",
    new Proxy(Function, {
      construct(target, args) {
        calls++;
        return Reflect.construct(target, args);
      },
      apply(target, self, args) {
        calls++;
        return Reflect.apply(target, self, args);
      },
    }),
  );
  return () => calls;
}

/** A value for each column a statement reads (`"col" as "c0"`), by the column's name. */
function answer(sql: string): Record<string, unknown>[] {
  const row: Record<string, unknown> = {};
  for (const [, column, alias] of sql.matchAll(/"(\w+)" as "(c\d+)"/g)) {
    row[alias as string] =
      column === "note" || column === "address" ? null : column === "title" || column === "name" ? "x" : 1;
  }
  return [row];
}

class FakeDriver implements DriverWrapper {
  readonly sql: string[] = [];
  init(): void {}
  async acquire(): Promise<DriverConnection> {
    const driver = this;
    return {
      async query(sql): Promise<RawResult> {
        driver.sql.push(sql);
        const rows = answer(sql);
        return { rows, rowCount: rows.length, insertId: undefined };
      },
      async cursor(): Promise<DriverCursor> {
        throw new Error("no cursors here");
      },
      async cancel(): Promise<void> {},
      inTransaction: () => false,
    };
  }
  async release(): Promise<void> {}
  async destroy(): Promise<void> {}
  stats(): PoolEvent {
    return { size: 1, idle: 1, waiting: 0 };
  }
  saturated(): boolean {
    return false;
  }
}

/** An application's schemas and repo, from fresh copies of the modules. */
async function application(codegen: boolean) {
  const { createAdapter } = await import("../../src/adapter/adapter.js");
  const { POSTGRES_CAPABILITIES } = await import("../../src/compiler/index.js");
  const egon = await import("../../src/index.js");
  const { belongsTo, cast, createRepo, EmbeddedSchema, from, hasMany, Schema, t } = egon;
  const options = codegen ? {} : { codegen: false };
  class Address extends EmbeddedSchema({ city: t.string() }, options) {
    static changeset(address: Address | typeof Address, params: unknown) {
      return cast(address, params, ["city"]);
    }
  }
  class Author extends Schema(
    "authors",
    {
      id: t.integer().primaryKey().dbGenerated(),
      name: t.string(),
      note: t.string().nullable(),
      address: t.embedOne(() => Address).nullable(),
    },
    options,
  ) {
    static books = hasMany(() => Book, { foreignKey: "authorId" });
  }
  class Book extends Schema(
    "books",
    { id: t.integer().primaryKey().dbGenerated(), title: t.string(), authorId: t.integer() },
    options,
  ) {
    static author = belongsTo(() => Author, { foreignKey: "authorId" });
  }
  const driver = new FakeDriver();
  const adapter = createAdapter({
    dialect: "postgres",
    capabilities: POSTGRES_CAPABILITIES,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: () => driver,
    driverCodecs: {},
    normalizeError: (error) => error,
  });
  const repo = createRepo({ adapter, codegen });
  return { egon, Author, Book, Address, repo, from, cast };
}

describe("codegen: false on every schema and on the repo", () => {
  test("defining schemas, casting, validating, reading, preloading and writing never generate code", async () => {
    const generated = countGeneration();
    const { Author, Book, repo, from, cast } = await application(false);
    const changeset = cast(Author, { name: "Ada", address: { city: "Paris" } }, ["name"])
      .castEmbed("address")
      .validateRequired(["name"])
      .validate(() => undefined);
    expect(changeset.valid).toBe(true);
    const authors = await repo.all(from(Author, "a").preload("books"));
    expect(authors[0]?.books[0]?.title).toBe("x");
    const joined = await repo.all(
      from(Book, "b")
        .joinAssoc("b", "author", "a")
        .select(({ b, a }) => ({ title: b.title, author: a })),
    );
    expect(joined[0]?.author).toBeInstanceOf(Author);
    const inserted = await repo.insertOrThrow(cast(Book, { title: "T", authorId: 1 }, ["title", "authorId"]));
    expect(inserted).toBeInstanceOf(Book);
    expect(generated()).toBe(0);
  });

  test("the same application with codegen on does generate (the count above is meaningful)", async () => {
    const generated = countGeneration();
    const { Author, repo, from } = await application(true);
    await repo.all(from(Author, "a").preload("books"));
    expect(generated()).toBeGreaterThan(0);
  });

  test("a changeset without a schema class never generates code: validate() uses loops", async () => {
    // It has no codegen option, so it never generates (owner decision, 2026-10-22): a
    // strict Content Security Policy sees no attempt to report.
    const generated = countGeneration();
    const { cast, t } = await import("../../src/index.js");
    let seen: unknown;
    const changeset = cast(
      {
        data: { page: 1, q: "old" },
        types: { q: t.string(), page: t.integer(), size: t.integer().nullable() },
      },
      { q: "new" },
      ["q", "size"],
    ).validate((values: unknown) => {
      seen = values;
      return undefined;
    });
    expect(changeset.valid).toBe(true);
    // The values a validator sees: the data with the changes applied, in field order.
    expect(seen).toEqual({ q: "new", page: 1, size: null });
    expect(Object.keys(seen as object)).toEqual(["q", "page", "size"]);
    expect(generated()).toBe(0);
  });

  test("the same validate() of a schema class does generate (the count above is meaningful)", async () => {
    const generated = countGeneration();
    const { cast, Schema, t } = await import("../../src/index.js");
    class Search extends Schema("searches", { id: t.integer().primaryKey(), q: t.string() }) {}
    cast(Search, { q: "new" }, ["q"]).validate(() => undefined);
    expect(generated()).toBeGreaterThan(0);
  });
});

describe("generated source holds names only as string literals", () => {
  // Names that would be code if they were pasted into the source.
  const hostile = fc.oneof(
    fc.string({ unit: "binary" }),
    fc.constantFrom(
      '"]; globalThis.__egonInjected = 1; //',
      "'); globalThis.__egonInjected = 1; ('",
      // A template literal's placeholder, written without being one here.
      `\`$\{globalThis.__egonInjected = 1}\``,
      '\\"]; globalThis.__egonInjected = 1; //',
      " globalThis.__egonInjected = 1",
      "*/ globalThis.__egonInjected = 1; /*",
      "\ud800",
    ),
  );
  const injected = () => (globalThis as { __egonInjected?: unknown }).__egonInjected;

  test("schema field names: the row factory and validate() keep every name, and run none", async () => {
    const { cast, meta, Schema, t } = await import("../../src/index.js");
    fc.assert(
      fc.property(
        fc.uniqueArray(
          hostile.filter(
            (name) => name !== "" && name !== "constructor" && name !== "toJSON" && !name.startsWith("$"),
          ),
          { minLength: 1, maxLength: 4 },
        ),
        (names) => {
          if (names.includes("__proto__") || names.includes("id")) return;
          const fields: Record<string, unknown> = {};
          names.forEach((name, i) => {
            fields[name] = t.string().nullable().column(`col${i}`);
          });
          let Defined: AnySchema;
          try {
            Defined = Schema("t", { id: t.integer().primaryKey(), ...fields } as never) as AnySchema;
          } catch {
            return; // A name the definition refuses: nothing was generated.
          }
          const info = meta(Defined);
          const values = [1, ...names.map((_, i) => `v${i}`)];
          const row = info.create(values, info.rowMeta("loaded", undefined)) as Record<string, unknown>;
          names.forEach((name, i) => {
            expect(row[name]).toBe(`v${i}`);
          });
          let seen: Record<string, unknown> = {};
          cast(Defined, Object.fromEntries(names.map((name) => [name, "w"])), names as never).validate(
            (given: unknown) => {
              seen = given as Record<string, unknown>;
              return undefined;
            },
          );
          for (const name of names) expect(seen[name]).toBe("w");
          expect(injected()).toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
  });

  test("select keys and column aliases: the decoder keeps every key, and runs none", async () => {
    const { generateDecoder } = await import("../../src/repo/hydrate.js");
    fc.assert(
      fc.property(fc.uniqueArray(hostile, { minLength: 1, maxLength: 5 }), (keys) => {
        const decode = generateDecoder(
          {
            kind: "object",
            keys,
            values: keys.map((key) => ({ kind: "value" as const, alias: key, type: undefined })),
          },
          { typeOverrides: () => undefined },
        );
        const row = Object.fromEntries(keys.map((key, i) => [key, i]));
        const out = decode(row, []) as Record<string, unknown>;
        expect(Object.keys(out)).toEqual(Object.keys(Object.fromEntries(keys.map((key) => [key, 0]))));
        keys.forEach((key, i) => {
          expect(Object.getOwnPropertyDescriptor(out, key)?.value).toBe(i);
        });
        expect(injected()).toBeUndefined();
      }),
      { numRuns: 500 },
    );
  });
});
