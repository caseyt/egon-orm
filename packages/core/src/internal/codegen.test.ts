// Code generation that survives a runtime refusing it while handling a request, as
// Cloudflare Workers do: allowed while the script starts, an EvalError afterwards.
import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A `Function` constructor that works until `refuse()` is called, then throws as workerd does. */
function fakeRuntime(): { readonly refuse: () => void; readonly attempts: () => number } {
  let refusing = false;
  let attempts = 0;
  vi.stubGlobal(
    "Function",
    new Proxy(Function, {
      construct(target, args) {
        attempts++;
        if (refusing) throw new EvalError("Code generation from strings disallowed for this context");
        return Reflect.construct(target, args);
      },
    }),
  );
  return {
    refuse: () => {
      refusing = true;
    },
    attempts: () => attempts,
  };
}

describe("generateFunction", () => {
  test("returns a function while allowed and undefined once refused, then stops asking", async () => {
    const runtime = fakeRuntime();
    const { generateFunction, generationRefused } = await import("./codegen.js");
    const make = generateFunction(["a"], "return a + 1;") as (a: number) => number;
    expect(make(1)).toBe(2);
    expect(generationRefused()).toBe(false);
    runtime.refuse();
    expect(generateFunction([], "return 1;")).toBeUndefined();
    expect(generationRefused()).toBe(true);
    expect(generateFunction([], "return 1;")).toBeUndefined();
    expect(runtime.attempts()).toBe(2);
  });

  test("an error that is not a refusal is thrown: it is a bug in the generated source", async () => {
    const { generateFunction, generationRefused } = await import("./codegen.js");
    expect(() => generateFunction([], "return (;")).toThrow(SyntaxError);
    expect(generationRefused()).toBe(false);
  });
});

/**
 * Runs the same work in a fresh copy of the modules: schemas defined at "startup", then,
 * after `atRequest` (which may make the runtime refuse code generation), everything that
 * generates code: a subclass's row factory, a factory with preloads, both validator
 * builders (of a schema and of a schemaless changeset) and a query decoder.
 */
async function scenario(atRequest: () => void): Promise<unknown> {
  const { meta, Schema, t, hasMany, belongsTo } = await import("../schema/index.js");
  const { cast } = await import("../changeset/changeset.js");
  const hydrate = await import("../repo/hydrate.js");

  const Base = Schema("authors", {
    id: t.integer().primaryKey().dbGenerated(),
    name: t.string(),
    note: t.string().nullable(),
    rank: t.integer().default(3),
  });
  class Author extends Base {
    static books = hasMany(() => Book, { foreignKey: "authorId" });
    get label(): string {
      return `${this.name} (${this.rank})`;
    }
  }
  class Book extends Schema("books", {
    id: t.integer().primaryKey(),
    title: t.string(),
    authorId: t.integer(),
  }) {
    static author = belongsTo(() => Author, { foreignKey: "authorId" });
  }

  atRequest();

  const seen: unknown[] = [];
  const record = (values: unknown): undefined => {
    seen.push(values);
    return undefined;
  };
  // The subclass's metadata (and row factory) is made on first use: at request time.
  const authors = meta(Author);
  const plain = authors.create([1, "Ada", null, 5], authors.rowMeta("loaded", undefined)) as Author;
  const withBooks = authors.createWith(["books"])(
    [2, "Bo", "n", 1],
    [[]],
    authors.rowMeta("loaded", undefined),
  ) as Author;
  cast(Author, { name: "Cy" }, ["name"]).validate(record);
  cast(plain, { note: "x" }, ["note"]).validate(record);
  cast({ data: { a: "x" }, types: { a: t.string(), b: t.integer().default(1) } }, { a: "y" }, ["a"]).validate(
    record,
  );
  const books = meta(Book);
  const decode = hydrate.buildDecoder(
    {
      kind: "row",
      meta: books,
      aliases: ["c0", "c1", "c2"],
      key: ["c0"],
      schema: undefined,
      nullable: false,
      preloads: [],
    },
    { typeOverrides: () => undefined },
    true,
  );
  const book = decode({ c0: 7, c1: "T", c2: 1 }, []) as Book;
  return {
    plain: { ...plain },
    plainIsAuthor: plain instanceof Author,
    label: plain.label,
    withBooks: { ...withBooks },
    seen,
    book: { ...book },
    bookIsBook: book instanceof Book,
    keys: [Object.keys(plain), Object.keys(withBooks), Object.keys(book)],
  };
}

describe("a runtime that refuses code generation at request time", () => {
  test("every generated path falls back to its loop and returns the same results", async () => {
    vi.resetModules();
    const generated = await scenario(() => {});

    vi.resetModules();
    const runtime = fakeRuntime();
    const fallback = await scenario(runtime.refuse);
    const { generationRefused } = await import("./codegen.js");

    // Something was generated at startup, and something was refused afterwards.
    expect(runtime.attempts()).toBeGreaterThan(1);
    expect(generationRefused()).toBe(true);
    expect(fallback).toStrictEqual(generated);
    expect(generated).toMatchObject({
      plain: { id: 1, name: "Ada", note: null, rank: 5 },
      plainIsAuthor: true,
      label: "Ada (5)",
      withBooks: { id: 2, books: [] },
      book: { id: 7, title: "T", authorId: 1 },
      bookIsBook: true,
    });
  });

  test("what Schema() generated at startup is still used after the refusal", async () => {
    const runtime = fakeRuntime();
    const { meta, Schema, t } = await import("../schema/index.js");
    const { cast } = await import("../changeset/changeset.js");
    class Gadget extends Schema("gadgets", { id: t.integer().primaryKey(), label: t.string() }) {}
    const atStartup = runtime.attempts();
    runtime.refuse();
    // The subclass's factory and the validator builders need no new code.
    const m = meta(Gadget);
    const row = m.create([1, "a"], m.rowMeta("loaded", undefined));
    let seen: unknown;
    cast(Gadget, { label: "b" }, ["label"]).validate((values: unknown) => {
      seen = values;
      return undefined;
    });
    expect(runtime.attempts()).toBe(atStartup);
    expect(row).toBeInstanceOf(Gadget);
    expect(seen).toStrictEqual({ label: "b" });
    const { generationRefused } = await import("./codegen.js");
    expect(generationRefused()).toBe(false);
  });
});
