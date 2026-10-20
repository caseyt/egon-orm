// Unit tests for preloading, over the real compiler and a fake driver that answers each
// statement from a small in-memory data set: no database. They check what is sent (the
// statements, their keys and their count), how children are grouped and attached, the
// merging of join preloads, chunking, ordering, `force`, that inputs are not changed, the
// options, the budget and the telemetry. The preload conformance suite runs the same
// behaviours against Postgres.
import { setFlagsFromString } from "node:v8";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { createAdapter, type DatabaseAdapter } from "../adapter/adapter.js";
import type { DriverConnection, DriverHooks, DriverWrapper } from "../adapter/driver.js";
import { POSTGRES_CAPABILITIES } from "../compiler/index.js";
import type { Capabilities, PoolEvent, RawResult } from "../contracts/adapter.js";
import type { AnySchema } from "../contracts/schema.js";
import { ROW } from "../contracts/schema.js";
import { DatabaseError, QueryError } from "../errors.js";
import {
  assoc,
  belongsTo,
  defineType,
  from,
  hasMany,
  hasOne,
  isLoaded,
  manyToMany,
  meta,
  param,
  Schema,
  t,
} from "../index.js";
import { KeyIndex } from "../query/assoc.js";
import type { RepoQueryEvent } from "./options.js";
import { copyValue, preloadLimits, withinBudget } from "./preload.js";
import { load, QueryHub, ReadCore } from "./read.js";
import { createRepo, type Repo } from "./repo.js";

// V8's %HaveSameMap says whether two objects share one hidden class (README §7).
setFlagsFromString("--allow-natives-syntax");
const haveSameMap = new Function("a", "b", "return %HaveSameMap(a, b)") as (a: object, b: object) => boolean;

// --- the schemas -----------------------------------------------------------------------

class Author extends Schema("authors", {
  id: t.integer().primaryKey(),
  name: t.string(),
  nick: t.string().virtual(),
}) {
  static bio = hasOne(() => Bio, { foreignKey: "authorId" });
  static books = hasMany(() => Book, { foreignKey: "authorId", orderBy: ["title"] });
  static notes = hasMany(() => Note, { foreignKey: "authorId" });
  static labels = hasMany(() => Label, { through: ["books", "labels"] });
  static chapters = hasMany(() => Chapter, { through: ["books", "chapters"] });
}

class Bio extends Schema("bios", {
  id: t.integer().primaryKey(),
  authorId: t.integer(),
  text: t.string(),
}) {}

class Book extends Schema("books", {
  id: t.integer().primaryKey(),
  authorId: t.integer().nullable(),
  title: t.string(),
  printedAt: t.timestamp().nullable(),
}) {
  static author = belongsTo(() => Author, { foreignKey: "authorId" });
  static labels = manyToMany(() => Label, {
    joinThrough: "book_labels",
    joinKeys: { owner: "book_id", target: "label_id" },
    joinWhere: { kind: "main" },
    where: { hidden: false },
  });
  static chapters = hasMany(() => Chapter, { foreignKey: "bookId", where: { draft: false } });
}

class Label extends Schema("labels", {
  id: t.integer().primaryKey(),
  name: t.string(),
  hidden: t.boolean(),
}) {}

class Chapter extends Schema("chapters", {
  id: t.integer().primaryKey(),
  bookId: t.integer(),
  n: t.integer(),
  draft: t.boolean(),
}) {}

/** A schema without a primary key. */
class Note extends Schema(
  "notes",
  {
    authorId: t.integer(),
    body: t.string(),
  },
  { primaryKey: false },
) {
  static author = belongsTo(() => Author, { foreignKey: "authorId" });
}

class Tagged extends Schema("books", { id: t.integer().primaryKey(), authorId: t.integer().nullable() }) {
  static labels = manyToMany(() => Tag2, {
    joinThrough: "book_labels",
    joinKeys: { owner: "book_id", target: "label_id" },
  });
}

class Tag2 extends Schema("labels", { id: t.integer().primaryKey(), name: t.string(), hidden: t.boolean() }) {
  static books = manyToMany(() => Tagged, {
    joinThrough: "book_labels",
    joinKeys: { owner: "label_id", target: "book_id" },
  });
}

class Shelf extends Schema("shelves", {
  region: t.string().primaryKey(),
  code: t.integer().primaryKey(),
}) {
  static volumes = hasMany(() => Volume, { foreignKey: ["shelfRegion", "shelfCode"] });
}

class Volume extends Schema("volumes", {
  id: t.integer().primaryKey(),
  shelfRegion: t.string().nullable(),
  shelfCode: t.integer().nullable(),
}) {
  static shelf = belongsTo(() => Shelf, { foreignKey: ["shelfRegion", "shelfCode"] });
}

// --- the data ----------------------------------------------------------------------------

type Data = Record<string, Record<string, unknown>[]>;

const DATA: Data = {
  authors: [
    { id: 1, name: "Ada" },
    { id: 2, name: "Grace" },
    { id: 3, name: "Linus" },
  ],
  bios: [{ id: 1, authorId: 1, text: "Mathematician" }],
  books: [
    { id: 10, authorId: 1, title: "Engines", printedAt: new Date("2026-01-01T00:00:00Z") },
    { id: 11, authorId: 1, title: "Notes", printedAt: null },
    { id: 20, authorId: 2, title: "Compilers", printedAt: null },
    { id: 30, authorId: null, title: "Orphan", printedAt: null },
  ],
  labels: [
    { id: 1, name: "sql", hidden: false },
    { id: 2, name: "ts", hidden: false },
  ],
  chapters: [
    { id: 100, bookId: 10, n: 1, draft: false },
    { id: 101, bookId: 10, n: 2, draft: false },
    { id: 200, bookId: 20, n: 1, draft: false },
  ],
  notes: [
    { authorId: 1, body: "a" },
    { authorId: 1, body: "b" },
  ],
  shelves: [
    { region: "n", code: 1 },
    { region: "s", code: 1 },
  ],
  volumes: [
    { id: 1, shelfRegion: "n", shelfCode: 1 },
    { id: 2, shelfRegion: "s", shelfCode: 1 },
    { id: 3, shelfRegion: null, shelfCode: null },
  ],
};

/** (book, label) pairs of `book_labels` for the many-to-many: the owner key is selected first. */
const BOOK_LABELS: [number, number][] = [
  [10, 1],
  [10, 2],
  [20, 1],
];

const SCHEMAS: Record<string, AnySchema> = {
  authors: Author,
  bios: Bio,
  books: Book,
  labels: Label,
  chapters: Chapter,
  notes: Note,
  shelves: Shelf,
  volumes: Volume,
};

/** The result row of `values` for schema `S`, its persisted fields read as `c<start>`, `c<start + 1>`, …. */
function raw(schema: AnySchema, values: Record<string, unknown>, start = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  meta(schema).persisted.forEach((field, i) => {
    out[`c${start + i}`] = values[field.name] ?? null;
  });
  return out;
}

/** The table a statement reads first: `from "books"`. */
function tableOf(sql: string): string {
  const found = /from (?:"[^"]+"\.)?"([^"]+)"/.exec(sql);
  return found?.[1] ?? "";
}

/** Answers a statement with every row of its table (children that match no parent are not attached). */
function answer(sql: string): Record<string, unknown>[] {
  const table = tableOf(sql);
  if (table === "labels") {
    // A joined route: `$o0` (the book) first, then the label.
    return BOOK_LABELS.map(([book, label]) => ({
      c0: book,
      ...raw(Label, DATA.labels?.find((row) => row.id === label) ?? {}, 1),
    }));
  }
  if (table === "chapters" && sql.includes('"$labels') === false && sql.includes("__via")) {
    // Author.chapters through books: `$o0` is the book's author.
    return (DATA.chapters ?? []).map((chapter) => ({
      c0: DATA.books?.find((book) => book.id === chapter.bookId)?.authorId ?? null,
      ...raw(Chapter, chapter, 1),
    }));
  }
  const schema = SCHEMAS[table];
  if (schema === undefined) return [];
  return (DATA[table] ?? []).map((row) => raw(schema, row));
}

// --- a driver without a database ------------------------------------------------------

interface Statement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

class FakeDriver implements DriverWrapper {
  readonly statements: Statement[] = [];
  hooks: DriverHooks | undefined;
  respond: (sql: string, params: readonly unknown[]) => readonly Record<string, unknown>[] | Error = answer;
  delayMs = 0;
  /** Statements running now, and the most that ever ran at once. */
  active = 0;
  most = 0;
  init(): void {}
  async acquire(): Promise<DriverConnection> {
    this.hooks?.connected();
    const driver = this;
    return {
      async query(sql, params): Promise<RawResult> {
        driver.statements.push({ sql, params });
        driver.active++;
        driver.most = Math.max(driver.most, driver.active);
        try {
          if (driver.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, driver.delayMs));
        } finally {
          driver.active--;
        }
        const rows = driver.respond(sql, params);
        if (rows instanceof Error) throw rows;
        return { rows, rowCount: rows.length, insertId: undefined };
      },
      async cursor() {
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

function setup(capabilities: Capabilities = POSTGRES_CAPABILITIES): {
  adapter: DatabaseAdapter;
  driver: FakeDriver;
} {
  const driver = new FakeDriver();
  const adapter = createAdapter({
    dialect: "postgres",
    capabilities,
    quoteIdentifier: (name) => `"${name.replaceAll('"', '""')}"`,
    driver: (hooks) => {
      driver.hooks = hooks;
      return driver;
    },
    driverCodecs: {},
    normalizeError: (error) => error,
  });
  return { adapter, driver };
}

function fake(options: { capabilities?: Capabilities; codegen?: boolean } = {}): {
  repo: Repo;
  driver: FakeDriver;
  events: RepoQueryEvent[];
  adapter: DatabaseAdapter;
} {
  const { adapter, driver } = setup(options.capabilities);
  const repo = createRepo({ adapter, codegen: options.codegen ?? true });
  const events: RepoQueryEvent[] = [];
  repo.on("query", (event) => events.push(event));
  return { repo, driver, events, adapter };
}

const tables = (driver: FakeDriver): string[] => driver.statements.map((statement) => tableOf(statement.sql));

// --- separate-query preloads ----------------------------------------------------------

describe("separate-query preloads", () => {
  test("hasMany: one statement for every parent, children grouped by key, empty arrays for none", async () => {
    const { repo, driver } = fake();
    const authors = await repo.all(from(Author, "a").preload("books"));
    expect(authors.map((author) => author.books.map((book) => book.id))).toEqual([[10, 11], [20], []]);
    expect(tables(driver)).toEqual(["authors", "books"]);
    expect(driver.statements[1]?.sql).toBe(
      'select "books"."id" as "c0", "books"."author_id" as "c1", "books"."title" as "c2", "books"."printed_at" as "c3" from "books" as "books" where "books"."author_id" = any($1) order by "books"."title" asc',
    );
    expect(driver.statements[1]?.params).toEqual([[1, 2, 3]]);
    expect(authors[0]?.books[0]).toBeInstanceOf(Book);
  });

  test("belongsTo: distinct keys, null keys left out, a shared target copied for every parent after the first", async () => {
    const { repo, driver } = fake();
    const books = await repo.all(from(Book, "b").preload("author"));
    expect(driver.statements[1]?.params).toEqual([[1, 2]]);
    expect(books.map((book) => book.author?.name ?? null)).toEqual(["Ada", "Ada", "Grace", null]);
    expect(books[0]?.author).not.toBe(books[1]?.author);
    expect(books[0]?.author).toEqual(books[1]?.author);
  });

  test("a level with no keys sends nothing", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => (tableOf(sql) === "books" ? [raw(Book, { id: 30, title: "Orphan" })] : []);
    const books = await repo.all(from(Book, "b").preload("author"));
    expect(books[0]?.author).toBeNull();
    expect(tables(driver)).toEqual(["books"]);
  });

  test("hasOne: the child or null", async () => {
    const { repo } = fake();
    const authors = await repo.all(from(Author, "a").preload("bio"));
    expect(authors.map((author) => author.bio?.text ?? null)).toEqual(["Mathematician", null, null]);
  });

  test("manyToMany: the join table and its condition, the target's where, the owner key read beside the row", async () => {
    const { repo, driver } = fake();
    const books = await repo.all(from(Book, "b").preload("labels"));
    expect(books.map((book) => book.labels.map((label) => label.name))).toEqual([
      ["sql", "ts"],
      [],
      ["sql"],
      [],
    ]);
    expect(driver.statements[1]?.sql).toBe(
      'select "$labels__join0"."book_id" as "c0", "labels"."id" as "c1", "labels"."name" as "c2", "labels"."hidden" as "c3" from "labels" as "labels" inner join "book_labels" as "$labels__join0" on "$labels__join0"."label_id" = "labels"."id" and "$labels__join0"."kind" = $1 where "labels"."hidden" = $2 and "$labels__join0"."book_id" = any($3)',
    );
    expect(driver.statements[1]?.params).toEqual(["main", false, [10, 11, 20, 30]]);
    const sql = books.flatMap((book) => book.labels).filter((label) => label.name === "sql");
    expect(sql[0]).not.toBe(sql[1]);
  });

  test("has-through: the chain joined backwards, the owner key from its first step", async () => {
    const { repo, driver } = fake();
    const authors = await repo.all(from(Author, "a").preload("chapters"));
    expect(authors.map((author) => author.chapters.map((chapter) => chapter.id))).toEqual([
      [100, 101],
      [200],
      [],
    ]);
    expect(driver.statements[1]?.sql).toBe(
      'select "$chapters__via1"."author_id" as "c0", "chapters"."id" as "c1", "chapters"."book_id" as "c2", "chapters"."n" as "c3", "chapters"."draft" as "c4" from "chapters" as "chapters" inner join "books" as "$chapters__via1" on "chapters"."book_id" = "$chapters__via1"."id" where "chapters"."draft" = $1 and "$chapters__via1"."author_id" = any($2)',
    );
    expect(Object.hasOwn(authors[0] as object, "books")).toBe(false);
  });

  test("has-through: a row reached twice for one parent is kept once", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => {
      if (tableOf(sql) === "authors") return [raw(Author, { id: 1, name: "Ada" })];
      // Label 1 by two books of author 1, and once for another author.
      const label = raw(Label, { id: 1, name: "sql", hidden: false }, 1);
      return [
        { c0: 1, ...label },
        { c0: 1, ...label },
        { c0: 2, ...label },
      ];
    };
    const authors = await repo.all(from(Author, "a").preload("labels"));
    expect(authors[0]?.labels.map((label) => label.id)).toEqual([1]);
    expect(driver.statements[1]?.sql).toContain('inner join "book_labels" as "$labels__join1"');
    expect(driver.statements[1]?.sql).toContain('inner join "books" as "$labels__via1"');
  });

  test("has-through: a selected shape has no key to de-duplicate by, and is kept as it comes", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) =>
      tableOf(sql) === "authors"
        ? [raw(Author, { id: 1, name: "Ada" })]
        : [
            { c0: 1, c1: "sql" },
            { c0: 1, c1: "sql" },
          ];
    const authors = await repo.all(
      from(Author, "a").preload("labels", (q) => q.select(({ labels }) => ({ name: labels.name }))),
    );
    expect(authors[0]?.labels).toEqual([{ name: "sql" }, { name: "sql" }]);
  });

  test("composite keys: a row of keys, matched on every part", async () => {
    const { repo, driver } = fake();
    const shelves = await repo.all(from(Shelf, "s").preload("volumes"));
    expect(shelves.map((shelf) => shelf.volumes.map((volume) => volume.id))).toEqual([[1], [2]]);
    expect(driver.statements[1]?.sql).toContain(
      'where ("volumes"."shelf_region", "volumes"."shelf_code") in (select "$keys"."k0" as "c0", "$keys"."k1" as "c1" from unnest(cast($1 as text[]), cast($2 as integer[])) as "$keys" ("k0", "k1"))',
    );
    expect(driver.statements[1]?.params).toEqual([
      ["n", "s"],
      [1, 1],
    ]);
    const volumes = await repo.all(from(Volume, "v").preload("shelf"));
    expect(volumes.map((volume) => volume.shelf?.region ?? null)).toEqual(["n", "s", null]);
  });

  test("composite keys where lists are not arrays: a values list", async () => {
    const { repo, driver } = fake({
      capabilities: { ...POSTGRES_CAPABILITIES, arrayParams: false, arrays: false },
    });
    const shelves = await repo.all(from(Shelf, "s").preload("volumes"));
    expect(shelves.map((shelf) => shelf.volumes.length)).toEqual([1, 1]);
    expect(driver.statements[1]?.sql).toContain(
      'from (values (cast($1 as text), cast($2 as integer)), (cast($3 as text), cast($4 as integer))) as "$keys"',
    );
  });

  test("nested levels: one statement per level, children of every parent together", async () => {
    const { repo, driver } = fake();
    const authors = await repo.all(from(Author, "a").preload({ books: ["chapters", "labels"], bio: true }));
    // Siblings in the order Book declares them: labels, then chapters.
    expect(tables(driver)).toEqual(["authors", "bios", "books", "labels", "chapters"]);
    expect(driver.statements[4]?.params).toEqual([false, expect.arrayContaining([10, 11, 20])]);
    expect(authors[0]?.books[0]?.chapters.map((chapter) => chapter.n)).toEqual([1, 2]);
    expect(authors[0]?.books[0]?.labels).toHaveLength(2);
  });

  test("a nested level below a many-to-many gets its rows their slots; a join below one is refused", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => {
      if (tableOf(sql) === "labels") {
        return BOOK_LABELS.map(([b, l]) => ({
          c0: b,
          ...raw(Tag2, { id: l, name: `l${l}`, hidden: false }, 1),
        }));
      }
      if (sql.includes("book_labels"))
        return BOOK_LABELS.map(([b, l]) => ({ c0: l, ...raw(Tagged, { id: b, authorId: 1 }, 1) }));
      return answer(sql);
    };
    const books = await repo.all(from(Tagged, "b").preload({ labels: "books" }));
    expect(books[0]?.labels[0]?.books.map((book) => book.id)).toEqual([10, 20]);
    expect(Object.keys(books[0]?.labels[0] as object)).toEqual(["id", "name", "hidden", "books"]);
    expect(driver.statements).toHaveLength(3);
    driver.statements.length = 0;
    await expect(
      repo.all(
        from(Tagged, "b").preload("labels", (q) =>
          q.joinAssoc("labels", "books", "bb").preload({ books: "bb" }),
        ),
      ),
    ).rejects.toThrow("a nested preload from a join is not supported under a many-to-many");
    expect(driver.statements).toEqual([]);
  });

  test("keys are split into statements of at most chunkKeys, and of maxParams where lists expand", async () => {
    const before = preloadLimits.chunkKeys;
    try {
      preloadLimits.chunkKeys = 2;
      const { repo, driver } = fake();
      driver.respond = (sql, params) =>
        tableOf(sql) === "books"
          ? answer(sql).filter((row) => (params[0] as unknown[]).includes(row.c1))
          : answer(sql);
      const authors = await repo.all(from(Author, "a").preload("books"));
      expect(driver.statements.slice(1).map((statement) => statement.params)).toEqual([[[1, 2]], [[3]]]);
      expect(authors[0]?.books).toHaveLength(2);
      preloadLimits.chunkKeys = 10_000;
      const small = fake({ capabilities: { ...POSTGRES_CAPABILITIES, arrayParams: false, maxParams: 2 } });
      await small.repo.all(from(Author, "a").preload("books"));
      expect(small.driver.statements.slice(1).map((statement) => statement.params)).toEqual([[1, 2], [3]]);
      const tiny = fake({ capabilities: { ...POSTGRES_CAPABILITIES, arrayParams: false, maxParams: 3 } });
      await tiny.repo.all(from(Book, "b").preload("labels"));
      // Two parameters of the route's own, so one key per statement at the least.
      expect(tiny.driver.statements).toHaveLength(5);
    } finally {
      preloadLimits.chunkKeys = before;
    }
  });

  test("10,000 keys is one statement; one more is two", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) =>
      tableOf(sql) === "authors"
        ? Array.from({ length: 10_001 }, (_, i) => raw(Author, { id: i + 1, name: "x" }))
        : [];
    await repo.all(from(Author, "a").preload("books"));
    expect(
      driver.statements.map((statement) => (statement.params[0] as unknown[] | undefined)?.length),
    ).toEqual([undefined, 10_000, 1]);
  });

  test("parents read from different database schemas are loaded from theirs", async () => {
    const { repo, driver, adapter } = fake();
    const plain = await repo.all(from(Author, "a"));
    const other = await repo.all(from(Author, "a"), { schema: "archive" });
    driver.statements.length = 0;
    const loaded = await repo.preload(Author, [plain[0], other[0]] as never[], "books");
    expect(driver.statements.map((statement) => statement.sql.includes('"archive"."books"'))).toEqual([
      false,
      true,
    ]);
    expect(loaded).toHaveLength(2);
    expect(adapter).toBeDefined();
  });
});

// --- the callback form ---------------------------------------------------------------

describe("callbacks", () => {
  test("the callback's where and order; the association's where is added", async () => {
    const { repo, driver } = fake();
    await repo.all(
      from(Book, "b").preload("chapters", (q) =>
        q.where(({ chapters }) => chapters.n.gt(0)).orderBy(({ chapters }) => chapters.n.desc()),
      ),
    );
    expect(driver.statements[1]?.sql).toBe(
      'select "chapters"."id" as "c0", "chapters"."book_id" as "c1", "chapters"."n" as "c2", "chapters"."draft" as "c3" from "chapters" as "chapters" where "chapters"."n" > $1 and "chapters"."draft" = $2 and "chapters"."book_id" = any($3) order by "chapters"."n" desc',
    );
  });

  test("limit and offset per parent: ranked in a subquery joined back on the key", async () => {
    const { repo, driver } = fake();
    await repo.all(
      from(Author, "a").preload("books", (q) =>
        q
          .orderBy(({ books }) => books.id.desc())
          .limit(2)
          .offset(1),
      ),
    );
    expect(driver.statements[1]?.sql).toBe(
      'select "books"."id" as "c0", "books"."author_id" as "c1", "books"."title" as "c2", "books"."printed_at" as "c3" from "books" as "books" inner join (select "books"."id" as "$k0", row_number() over (partition by "books"."author_id" order by "books"."id" desc) as "$rank" from "books" as "books" where "books"."author_id" = any($1)) as "$books__ranked" on "$books__ranked"."$k0" = "books"."id" where "$books__ranked"."$rank" > $2 and "$books__ranked"."$rank" - $3 <= $4 order by "$books__ranked"."$rank" asc',
    );
    expect(driver.statements[1]?.params).toEqual([[1, 2, 3], 1, 1, 2]);
  });

  test("a limit alone, by the association's order, on a many-to-many", async () => {
    const { repo, driver } = fake();
    await repo.all(from(Author, "a").preload("books", (q) => q.limit(1)));
    expect(driver.statements[1]?.sql).toContain('order by "books"."title" asc) as "$rank"');
    expect(driver.statements[1]?.sql).toContain('where "$books__ranked"."$rank" <= $2');
    await repo.all(from(Book, "b").preload("labels", (q) => q.orderBy(({ labels }) => labels.name).limit(1)));
    const last = driver.statements.at(-1)?.sql ?? "";
    expect(last).toContain(
      '"$labels__join0"."book_id" as "$o0", row_number() over (partition by "$labels__join0"."book_id"',
    );
    expect(last).toContain('and "$labels__ranked"."$o0" = "$labels__join0"."book_id"');
  });

  test("a per-parent limit where a has-through row can repeat, or the target has no key, is refused before anything runs", async () => {
    const { repo, driver } = fake();
    await expect(
      repo.all(from(Author, "a").preload("labels", (q) => q.orderBy(({ labels }) => labels.id).limit(1))),
    ).rejects.toThrow("can be reached along more than one path");
    await expect(
      repo.all(from(Author, "a").preload("notes", (q) => q.orderBy(({ notes }) => notes.body).limit(1))),
    ).rejects.toThrow("needs Note to have a primary key");
    expect(driver.statements).toEqual([]);
  });

  test("a selected shape: plain objects, matched on the selected key", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) =>
      tableOf(sql) === "books"
        ? [
            { c0: 1, c1: "Engines" },
            { c0: 2, c1: "Compilers" },
          ]
        : answer(sql);
    const authors = await repo.all(
      from(Author, "a").preload("books", (q) =>
        q.select(({ books }) => ({ authorId: books.authorId, title: books.title })),
      ),
    );
    expect(authors.map((author) => author.books)).toEqual([
      [{ authorId: 1, title: "Engines" }],
      [{ authorId: 2, title: "Compilers" }],
      [],
    ]);
  });

  test("a selected shape of a many-to-many sits beside the owner key", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => (tableOf(sql) === "labels" ? [{ c0: 10, c1: "sql" }] : answer(sql));
    const books = await repo.all(
      from(Book, "b").preload("labels", (q) => q.select(({ labels }) => ({ name: labels.name }))),
    );
    expect(books[0]?.labels).toEqual([{ name: "sql" }]);
  });

  test("a callback's named parameters are bound in its statement only", async () => {
    const { repo, driver } = fake();
    const query = from(Author, "a")
      .where(({ a }) => a.id.lt(param("max", t.integer())))
      .preload("books", (q) => q.where(({ books }) => books.title.neq(param("skip", t.string()))));
    await repo.all(query, { max: 9, skip: "Notes" });
    expect(driver.statements.map((statement) => statement.params)).toEqual([[9], ["Notes", [1, 2, 3]]]);
    await expect(repo.all(query, { max: 9 } as never)).rejects.toThrow('"skip"');
  });
});

// --- join preloads ----------------------------------------------------------------------

describe("join preloads", () => {
  /** A result row of an author joined to a book (and a chapter). */
  const joined = (author: number, book: number | null, chapter: number | null = null) => ({
    ...raw(Author, DATA.authors?.find((row) => row.id === author) ?? {}),
    ...raw(Book, book === null ? {} : (DATA.books?.find((row) => row.id === book) ?? {}), 2),
    ...raw(Chapter, chapter === null ? {} : (DATA.chapters?.find((row) => row.id === chapter) ?? {}), 6),
  });

  test("parents repeated by their children become one, in first-seen order", async () => {
    const { repo, driver } = fake();
    driver.respond = () => [joined(2, 20), joined(1, 10), joined(1, 11), joined(3, null), joined(2, 20)];
    const authors = await repo.all(
      from(Author, "a").leftJoinAssoc("a", "books", "b").preload({ books: "b" }),
    );
    expect(authors.map((author) => [author.id, author.books.map((book) => book.id)])).toEqual([
      [2, [20]],
      [1, [10, 11]],
      [3, []],
    ]);
    expect(driver.statements).toHaveLength(1);
  });

  test("nested join preloads merge at every level, and a separate preload runs below them", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) =>
      tableOf(sql) === "authors"
        ? [joined(1, 10, 100), joined(1, 10, 101), joined(1, 11, null), joined(2, 20, 200)]
        : answer(sql);
    const authors = await repo.all(
      from(Author, "a")
        .leftJoinAssoc("a", "books", "b")
        .leftJoinAssoc("b", "chapters", "c")
        .preload({ books: { $from: "b", chapters: "c", labels: true } }),
    );
    expect(
      authors.map((author) => author.books.map((book) => [book.id, book.chapters.map((c) => c.id)])),
    ).toEqual([
      [
        [10, [100, 101]],
        [11, []],
      ],
      [[20, [200]]],
    ]);
    expect(authors[0]?.books[0]?.labels.map((label) => label.name)).toEqual(["sql", "ts"]);
    expect(tables(driver)).toEqual(["authors", "labels"]);
  });

  test("a to-one join preload keeps the first child, and merges what is below it", async () => {
    const { repo, driver } = fake();
    // book, its author, the author's books (a join below a to-one join).
    const row = (book: number, author: number | null, other: number | null) => ({
      ...raw(Book, DATA.books?.find((b) => b.id === book) ?? {}),
      ...raw(Author, author === null ? {} : (DATA.authors?.find((a) => a.id === author) ?? {}), 4),
      ...raw(Book, other === null ? {} : (DATA.books?.find((b) => b.id === other) ?? {}), 6),
    });
    driver.respond = () => [row(10, 1, 10), row(10, 1, 11), row(30, null, null), row(30, null, null)];
    const books = await repo.all(
      from(Book, "b")
        .leftJoinAssoc("b", "author", "a")
        .leftJoinAssoc("a", "books", "o")
        .preload({ author: { $from: "a", books: "o" } }),
    );
    expect(books.map((book) => [book.id, book.author?.books.map((b) => b.id) ?? null])).toEqual([
      [10, [10, 11]],
      [30, null],
    ]);
  });

  test("a to-one child missing on the first row is taken from a later one", async () => {
    const { repo, driver } = fake();
    driver.respond = () => [
      { ...raw(Book, DATA.books?.[0] ?? {}), ...raw(Author, {}, 4) },
      { ...raw(Book, DATA.books?.[0] ?? {}), ...raw(Author, DATA.authors?.[0] ?? {}, 4) },
    ];
    const books = await repo.all(from(Book, "b").leftJoinAssoc("b", "author", "a").preload({ author: "a" }));
    expect(books[0]?.author?.name).toBe("Ada");
  });

  test("a keyless parent cannot be merged; keyless children are kept as they are", async () => {
    const { repo, driver } = fake();
    driver.respond = () => [];
    await expect(
      repo.all(from(Note, "n").leftJoinAssoc("n", "author", "a").preload({ author: "a" })),
    ).rejects.toThrow("Note has none");
    driver.respond = () => [
      { ...raw(Author, DATA.authors?.[0] ?? {}), ...raw(Note, { authorId: 1, body: "a" }, 2) },
      { ...raw(Author, DATA.authors?.[0] ?? {}), ...raw(Note, { authorId: 1, body: "a" }, 2) },
    ];
    const authors = await repo.all(
      from(Author, "a").leftJoinAssoc("a", "notes", "n").preload({ notes: "n" }),
    );
    expect(authors[0]?.notes).toHaveLength(2);
  });

  test("property: join rows flattened from a tree decode back to the tree", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.integer({ min: 1, max: 6 }),
            fc.uniqueArray(fc.integer({ min: 1, max: 20 }), { maxLength: 4 }),
          ),
          {
            maxLength: 6,
          },
        ),
        async (spec) => {
          // Unique parents; each child id belongs to one parent only.
          const seen = new Set<number>();
          const tree = new Map<number, number[]>();
          for (const [parent, children] of spec) {
            if (tree.has(parent)) continue;
            tree.set(
              parent,
              children.filter((child) => {
                if (seen.has(child)) return false;
                seen.add(child);
                return true;
              }),
            );
          }
          const rows: Record<string, unknown>[] = [];
          for (const [parent, children] of tree) {
            const author = raw(Author, { id: parent, name: `a${parent}` });
            if (children.length === 0) rows.push({ ...author, ...raw(Book, {}, 2) });
            // Each child twice, as a sibling join would repeat it.
            for (const child of children) {
              for (let i = 0; i < 2; i++)
                rows.push({ ...author, ...raw(Book, { id: child, authorId: parent, title: "t" }, 2) });
            }
          }
          const { repo, driver } = fake();
          driver.respond = () => rows;
          const authors = await repo.all(
            from(Author, "a").leftJoinAssoc("a", "books", "b").preload({ books: "b" }),
          );
          expect(authors.map((author) => [author.id, author.books.map((book) => book.id)])).toEqual([
            ...tree,
          ]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- repo.preload -----------------------------------------------------------------------

describe("repo.preload", () => {
  test("returns new rows built with the association slots; the inputs are not changed", async () => {
    const { repo, driver } = fake();
    const authors = await repo.all(from(Author, "a"));
    (authors[0] as { nick: string }).nick = "the countess";
    const loaded = await repo.preload(Author, authors, "books");
    expect(loaded.map((author) => author.books.length)).toEqual([2, 1, 0]);
    expect(loaded[0]).not.toBe(authors[0]);
    expect(loaded[0]?.nick).toBe("the countess");
    expect(Object.hasOwn(authors[0] as object, "books")).toBe(false);
    expect((loaded[0] as unknown as Record<symbol, unknown>)[ROW]).toBe(
      (authors[0] as unknown as Record<symbol, unknown>)[ROW],
    );
    expect(tables(driver)).toEqual(["authors", "books"]);
  });

  test("one row, null, an empty array", async () => {
    const { repo, driver } = fake();
    const [ada] = await repo.all(from(Author, "a"));
    const one = await repo.preload(Author, ada as Author, "bio");
    expect(one.bio?.text).toBe("Mathematician");
    expect(await repo.preload(Author, null, "bio")).toBeNull();
    expect(await repo.preload(Author, [], "bio")).toEqual([]);
    expect(driver.statements).toHaveLength(2);
  });

  test("skips what is loaded, applies nested preloads to it, and reloads it with force", async () => {
    const { repo, driver } = fake();
    const authors = await repo.all(from(Author, "a").preload("books"));
    driver.statements.length = 0;
    const deeper = await repo.preload(Author, authors, { books: "chapters", bio: true });
    expect(tables(driver)).toEqual(["bios", "chapters"]);
    expect(deeper[0]?.books[0]?.chapters).toHaveLength(2);
    expect(Object.hasOwn(authors[0]?.books[0] as object, "chapters")).toBe(false);
    expect(Object.keys(deeper[0] as object).slice(-2)).toEqual(["bio", "books"]);
    driver.statements.length = 0;
    const forced = await repo.preload(Author, authors, "books", { force: true });
    expect(tables(driver)).toEqual(["books"]);
    // Loaded again: new rows, not the ones the input held.
    expect(forced[0]?.books[0]).not.toBe(authors[0]?.books[0]);
    expect(forced[0]?.books[0]).toEqual(authors[0]?.books[0]);
    // Loaded again when the database has none now: empty, not what the input held.
    driver.respond = (sql) => (tableOf(sql) === "books" ? [] : answer(sql));
    const emptied = await repo.preload(Author, authors, "books", { force: true });
    expect(emptied.map((author) => author.books)).toEqual([[], [], []]);
  });

  test("a row given twice gets two copies of its children", async () => {
    const { repo } = fake();
    const [ada] = await repo.all(from(Author, "a"));
    const [first, second] = await repo.preload(Author, [ada, ada] as Author[], "books");
    expect(first?.books).not.toBe(second?.books);
    expect(first?.books[0]).not.toBe(second?.books[0]);
    expect(first?.books).toEqual(second?.books);
  });

  test("a row that had a to-one association loaded keeps it, and gets the nested level", async () => {
    const { repo } = fake();
    const books = await repo.all(from(Book, "b").preload("author"));
    const deeper = await repo.preload(Book, books, { author: "bio" });
    expect(deeper[0]?.author?.bio?.text).toBe("Mathematician");
    expect(deeper[3]?.author).toBeNull();
  });

  test("nothing can be preloaded below a selected shape", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => (tableOf(sql) === "books" ? [{ c0: 1, c1: "x" }] : answer(sql));
    const authors = await repo.all(
      from(Author, "a").preload("books", (q) =>
        q.select(({ books }) => ({ authorId: books.authorId, title: books.title })),
      ),
    );
    await expect(repo.preload(Author, authors as never[], { books: "chapters" })).rejects.toThrow(
      "selected values",
    );
  });

  test("the callback form takes values; named parameters and extra arguments are refused", async () => {
    const { repo, driver } = fake();
    const authors = await repo.all(from(Author, "a"));
    await repo.preload(Author, authors, "books", (q) => q.where(({ books }) => books.title.neq("Notes")), {
      force: true,
    });
    expect(driver.statements.at(-1)?.params).toEqual(["Notes", [1, 2, 3]]);
    const named = (q: { where(fn: unknown): unknown }) =>
      q.where(({ books }: { books: { title: { neq(v: unknown): unknown } } }) =>
        books.title.neq(param("skip", t.string())),
      );
    await expect(repo.preload(Author, authors, "books", named as never)).rejects.toThrow(
      'not named parameters ("skip")',
    );
    const untyped = repo.preload as unknown as (...args: unknown[]) => Promise<unknown>;
    await expect(untyped.call(repo, Author, authors, "books", {}, {})).rejects.toThrow("options last");
  });

  test("refuses what is not a row of the schema, a spec that is not valid, and bad options", async () => {
    const { repo } = fake();
    const books = await repo.all(from(Book, "b"));
    await expect(repo.preload(Author, books as never, "books")).rejects.toThrow("is a row of Book");
    await expect(repo.preload(Author, [{ id: 1 }] as never, "books")).rejects.toThrow(TypeError);
    await expect(repo.preload(Author, [null] as never, "books")).rejects.toThrow(TypeError);
    await expect(repo.preload(Author, [1] as never, "books")).rejects.toThrow(TypeError);
    await expect(repo.preload(Author, [], "nope" as never)).rejects.toThrow('has no association "nope"');
    await expect(repo.preload("Author" as never, [], "books" as never)).rejects.toThrow(TypeError);
    await expect(repo.preload(Author, [], "books", { force: "yes" } as never)).rejects.toThrow(
      "force must be",
    );
    await expect(repo.preload(Author, [], "books", { bogus: 1 } as never)).rejects.toThrow(
      'unknown option "bogus"',
    );
  });
});

// --- reload -----------------------------------------------------------------------------

describe("reload", () => {
  test("loads again what was loaded, to the depth the rows show", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql, params) => {
      if (sql.includes('"$keys"')) {
        // reload: the row and its position.
        return (params[0] as number[]).map((id, i) => ({
          ...raw(Author, DATA.authors?.find((row) => row.id === id) ?? {}),
          c2: i + 1,
        }));
      }
      return answer(sql);
    };
    const authors = await repo.all(from(Author, "a").preload({ books: "chapters", bio: true }));
    driver.statements.length = 0;
    const fresh = await repo.reload(authors);
    expect(tables(driver)).toEqual(["authors", "bios", "books", "chapters"]);
    expect(fresh[0]?.books[0]?.chapters).toHaveLength(2);
    expect(fresh[0]).not.toBe(authors[0]);
    driver.statements.length = 0;
    const plain = await repo.all(from(Author, "a"));
    driver.statements.length = 0;
    await repo.reload(plain);
    expect(tables(driver)).toEqual(["authors"]);
  });
});

// --- options, budget, concurrency and telemetry ---------------------------------------------

describe("options", () => {
  test("statements report the operation preload and the table", async () => {
    const { repo, events } = fake();
    await repo.all(from(Author, "a").preload("books"), { context: { request: "r1" } });
    expect(events.map((event) => [event.operation, event.source, event.context])).toEqual([
      ["all", "authors", { request: "r1" }],
      ["preload", "books", { request: "r1" }],
    ]);
  });

  test("a value a preload cannot decode is reported and thrown", async () => {
    const strict = defineType<number, unknown>({
      name: "strict",
      db: { kind: "integer" },
      cast: () => ({ success: false }),
      fromDb: () => {
        throw new Error("cannot decode");
      },
      toDb: (value) => value,
      equal: Object.is,
    });
    class Odd extends Schema("odd", {
      id: t.integer().primaryKey(),
      authorId: t.integer(),
      v: t.type(strict),
    }) {}
    class Owner extends Schema("authors", { id: t.integer().primaryKey() }) {
      static odds = hasMany(() => Odd, { foreignKey: "authorId" });
    }
    const { repo, driver, events } = fake();
    driver.respond = (sql) => (tableOf(sql) === "odd" ? [{ c0: 1, c1: 1, c2: 5 }] : [{ c0: 1 }]);
    await expect(repo.all(from(Owner, "o").preload("odds"))).rejects.toThrow("cannot decode");
    expect(events[1]?.error).toBeInstanceOf(Error);
    driver.respond = (sql) => (tableOf(sql) === "odd" ? new Error("boom") : [{ c0: 1 }]);
    await expect(repo.all(from(Owner, "o").preload("odds"))).rejects.toThrow("boom");
  });

  test("timeoutMs is one budget for the main statement and every preload", async () => {
    const { repo, driver } = fake();
    driver.delayMs = 40;
    const error = await repo
      .all(from(Author, "a").preload({ books: "chapters" }), { timeoutMs: 100 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe("timeout");
    expect((error as Error).message).toContain("timeoutMs (100 ms)");
    driver.delayMs = 0;
    driver.respond = () => new Error("plain");
    await expect(repo.preload(Author, [], "books", { timeoutMs: 5 })).resolves.toEqual([]);
    expect(withinBudget({ context: {} }, undefined)).toEqual({ context: {} });
  });

  test("a failure of a preload statement without a budget is thrown as it is", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => (tableOf(sql) === "books" ? new Error("plain") : answer(sql));
    await expect(repo.all(from(Author, "a").preload("books"))).rejects.toThrow("plain");
  });

  test("maxConcurrency runs siblings together on a pool, one at a time on a connection", async () => {
    const { repo, driver, adapter } = fake();
    driver.delayMs = 10;
    const query = from(Author, "a").preload(["bio", "books", "notes"]);
    const together = await repo.all(query, { maxConcurrency: 2 });
    expect(driver.most).toBe(2);
    driver.most = 0;
    const apart = await repo.all(query);
    expect(driver.most).toBe(1);
    expect(together).toEqual(apart);
    await expect(repo.all(query, { maxConcurrency: 0 })).rejects.toThrow("maxConcurrency");
    await expect(repo.all(query, { maxConcurrency: 1.5 })).rejects.toThrow("maxConcurrency");
    // On one connection: a core whose executor is a connection.
    const connection = await adapter.acquire();
    const core = new ReadCore(adapter, connection, undefined, true, new QueryHub(adapter, false));
    driver.most = 0;
    const rows = (await load(core, "all", query.ast, undefined, { maxConcurrency: 3 })) as Author[];
    expect(rows).toHaveLength(3);
    expect(driver.most).toBe(1);
    await connection.release();
  });
});

// --- copies, keys, assoc() and isLoaded() -------------------------------------------------

describe("copies", () => {
  test("rows, arrays, plain objects, dates and bytes are copied; other objects are shared", async () => {
    const { repo } = fake();
    const [book] = await repo.all(from(Book, "b").preload({ author: "books" }));
    const copy = copyValue(book) as Book & { author: Author & { books: Book[] } };
    expect(copy).not.toBe(book);
    expect(copy).toEqual(book);
    expect(copy.printedAt).not.toBe(book?.printedAt);
    expect(copy.author).not.toBe(book?.author);
    expect(copy.author.books[0]).not.toBe((book as unknown as { author: { books: Book[] } }).author.books[0]);
    const bytes = new Uint8Array([1, 2]);
    expect(copyValue(bytes)).not.toBe(bytes);
    expect(copyValue(bytes)).toEqual(bytes);
    const plain = { a: [1, { b: 2 }] };
    expect(copyValue(plain)).toEqual(plain);
    expect((copyValue(plain) as typeof plain).a).not.toBe(plain.a);
    const custom = new Map();
    expect(copyValue(custom)).toBe(custom);
    expect(copyValue(null)).toBeNull();
    expect(copyValue(3)).toBe(3);
    const loose = Object.create({ notASchema: true }) as object;
    Object.defineProperty(loose, ROW, { value: { state: "loaded" } });
    expect(copyValue(loose)).toBe(loose);
  });
});

describe("KeyIndex", () => {
  test("primitives, dates by time, and other values by their type's equal", () => {
    const decimal = defineType<string, string>({
      name: "dec",
      db: { kind: "decimal" },
      cast: (input) => ({ success: true, data: String(input) }),
      fromDb: (value) => value,
      toDb: (value) => value,
      equal: (a, b) => Number(a) === Number(b),
    });

    const types = [
      meta(Book).fieldsByName.get("id")?.type,
      meta(Book).fieldsByName.get("printedAt")?.type,
      decimal,
    ];
    const keyed = new KeyIndex<string>(types as never);
    keyed.set([1, new Date(5), "1.0"], "a");
    expect(keyed.get([1, new Date(5), "1.00"])).toBe("a");
    expect(keyed.get([1, new Date(6), "1.0"])).toBeUndefined();
    expect(keyed.get([2, new Date(5), "1.0"])).toBeUndefined();
    keyed.set([1, new Date(5), "1"], "b");
    expect(keyed.get([1, new Date(5), "1.0"])).toBe("b");
    expect(keyed.get([1, new Date(5), "2"])).toBeUndefined();
    const text = new KeyIndex<number>([meta(Shelf).fieldsByName.get("region")?.type as never]);
    text.set(["n"], 1);
    expect(text.get(["n"])).toBe(1);
    expect(text.get([])).toBeUndefined();
  });
});

describe("assoc and isLoaded", () => {
  test("assoc() builds a query of the associated rows", async () => {
    const { repo, driver } = fake();
    const authors = await repo.all(from(Author, "a"));
    const books = await repo.all(from(Book, "b"));
    const shelves = await repo.all(from(Shelf, "s"));
    driver.statements.length = 0;
    await repo.all(assoc(Author, authors, "books"));
    await repo.all(assoc(Book, books[0] as Book, "author"));
    await repo.all(assoc(Book, books, "labels"));
    await repo.all(assoc(Author, authors[0] as Author, "chapters"));
    await repo.all(assoc(Shelf, shelves, "volumes"));
    await repo.all(assoc(Shelf, [], "volumes"));
    const sql = driver.statements.map((statement) => statement.sql);
    expect(sql[0]).toContain('where "books"."author_id" = any($1)');
    expect(driver.statements[0]?.params).toEqual([[1, 2, 3]]);
    expect(sql[1]).toContain('where "author"."id" = any($1)');
    expect(sql[2]).toContain(
      'where "labels"."id" in (select "target"."id" as "c0" from "books" as "owner" inner join "book_labels"',
    );
    expect(sql[3]).toContain('"chapters"."id" in (select "target"."id" as "c0" from "authors" as "owner"');
    expect(sql[4]).toContain('("volumes"."shelf_region" = $1 and "volumes"."shelf_code" = $2) or');
    expect(sql[5]).toContain('from "volumes" as "volumes" where false');
  });

  test("assoc() refuses what it cannot query", () => {
    expect(() => assoc("Author" as never, [], "books" as never)).toThrow(TypeError);
    expect(() => assoc(Author, [{ id: 1 }] as never, "books")).toThrow(TypeError);
    class Keyless extends Schema("keyless", { a: t.integer(), b: t.integer() }, { primaryKey: false }) {}
    class Holder extends Schema("holders", { id: t.integer().primaryKey() }) {
      static many = hasMany(() => Pair, { foreignKey: "holderId" });
      static keyless = hasMany(() => Keyless, { through: ["many", "keyless"] });
    }
    class Pair extends Schema("pairs", { id: t.integer().primaryKey(), holderId: t.integer() }) {
      static keyless = hasMany(() => Keyless, { foreignKey: "a" });
    }
    expect(() => assoc(Holder, [], "keyless")).toThrow("needs a primary key of exactly one field");
    expect(() => assoc(Holder, [], "nope" as never)).toThrow('Holder has no association "nope"');
    void Pair;
  });

  test("isLoaded", async () => {
    const { repo } = fake();
    const [plain] = await repo.all(from(Author, "a"));
    const [loaded] = await repo.all(from(Author, "a").preload("books"));
    expect(isLoaded(Author, plain as Author, "books")).toBe(false);
    expect(isLoaded(Author, loaded as Author, "books")).toBe(true);
    expect(isLoaded(Author, null as never, "books")).toBe(false);
    expect(() => isLoaded(Author, plain as Author, "nope" as never)).toThrow(QueryError);
  });
});

// --- row shapes -------------------------------------------------------------------------

describe("row shapes", () => {
  test("one hidden class per schema and set of preloads, however the rows were loaded", async () => {
    for (const codegen of [true, false]) {
      const { repo, driver } = fake({ codegen });
      driver.respond = (sql, params) =>
        sql.includes('"$keys"')
          ? (params[0] as number[]).map((id, i) => ({
              ...raw(Author, DATA.authors?.find((row) => row.id === id) ?? {}),
              c2: i + 1,
            }))
          : answer(sql);
      const a = await repo.all(from(Author, "a").preload("books").preload("bio"));
      const b = await repo.all(from(Author, "a").preload(["bio", "books"]));
      const c = await repo.preload(Author, await repo.all(from(Author, "a")), ["books", "bio"]);
      const d = await repo.preload(Author, await repo.all(from(Author, "a").preload("books")), "bio");
      const e = await repo.reload(a);
      const rows = [...a, ...b, ...c, ...d, ...(e as object[])] as object[];
      for (const row of rows) expect(haveSameMap(rows[0] as object, row)).toBe(true);
      const children = rows.flatMap(
        (row) => (row as unknown as Author & { books: Book[] }).books,
      ) as object[];
      for (const child of children) expect(haveSameMap(children[0] as object, child)).toBe(true);
      // Another set of preloads is another shape.
      const other = await repo.all(from(Author, "a").preload("books"));
      expect(haveSameMap(rows[0] as object, other[0] as object)).toBe(false);
      // A copy for a second parent has the shape of the first.
      const books = await repo.all(from(Book, "b").preload("author"));
      expect(haveSameMap(books[0]?.author as object, books[1]?.author as object)).toBe(true);
    }
  });
});

// --- the remaining cases --------------------------------------------------------------

class Member extends Schema("members", {
  groupId: t.integer().primaryKey(),
  personId: t.integer().primaryKey(),
}) {}

class Group extends Schema("groups", { id: t.integer().primaryKey() }) {
  static people = manyToMany(() => Person, {
    joinThrough: () => Member,
    joinKeys: { owner: "groupId", target: "personId" },
  });
  static active = hasMany(() => Person, { foreignKey: "groupId", where: { leftAt: null, level: [1, 2] } });
}

class Person extends Schema("people", {
  id: t.integer().primaryKey(),
  groupId: t.integer(),
  leftAt: t.timestamp().nullable(),
  level: t.integer(),
}) {}

class Reader extends Schema("authors", { id: t.integer().primaryKey() }) {
  static books = hasMany(() => Tagged, { foreignKey: "authorId" });
  static labels = hasMany(() => Tag2, { through: ["books", "labels"] });
}

class Blob extends Schema("blobs", { data: t.binary().primaryKey(), day: t.date() }) {}

describe("more cases", () => {
  test("a where with null and a list, and a join schema", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => (tableOf(sql) === "groups" ? [{ c0: 1 }] : []);
    await repo.all(from(Group, "g").preload(["people", "active"]));
    expect(driver.statements[1]?.sql).toContain(
      'inner join "members" as "$people__join0" on "$people__join0"."person_id" = "people"."id"',
    );
    expect(driver.statements[2]?.sql).toContain(
      'where "active"."left_at" is null and "active"."level" = any($1)',
    );
  });

  test("a join preload below a direct preload's callback is merged; keyless rows are kept", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => {
      if (tableOf(sql) === "authors") return [raw(Author, { id: 1, name: "Ada" })];
      if (tableOf(sql) === "books") {
        // Book 10 twice (two chapters), book 11 once.
        return [
          {
            ...raw(Book, DATA.books?.[0] ?? {}),
            ...raw(Chapter, { id: 100, bookId: 10, n: 1, draft: false }, 4),
          },
          {
            ...raw(Book, DATA.books?.[0] ?? {}),
            ...raw(Chapter, { id: 101, bookId: 10, n: 2, draft: false }, 4),
          },
          { ...raw(Book, DATA.books?.[1] ?? {}), ...raw(Chapter, {}, 4) },
        ];
      }
      return [
        { ...raw(Note, { authorId: 1, body: "a" }), ...raw(Author, { id: 1, name: "Ada" }, 2) },
        { ...raw(Note, { authorId: 1, body: "a" }), ...raw(Author, { id: 1, name: "Ada" }, 2) },
      ];
    };
    const authors = await repo.all(
      from(Author, "a")
        .preload("books", (q) => q.leftJoinAssoc("books", "chapters", "ch").preload({ chapters: "ch" }))
        .preload("notes", (q) => q.joinAssoc("notes", "author", "na").preload({ author: "na" })),
    );
    expect(authors[0]?.books.map((book) => [book.id, book.chapters.map((chapter) => chapter.id)])).toEqual([
      [10, [100, 101]],
      [11, []],
    ]);
    expect(authors[0]?.notes).toHaveLength(2);
  });

  test("a has-through with a join below it is refused", async () => {
    const { repo } = fake();
    await expect(
      repo.all(
        from(Reader, "r").preload("labels", (q) =>
          q.joinAssoc("labels", "books", "bb").preload({ books: "bb" }),
        ),
      ),
    ).rejects.toThrow("under a has-through association");
  });

  test("a callback that selects the whole binding, an offset alone, and a limit where lists expand", async () => {
    const { repo, driver } = fake({ capabilities: { ...POSTGRES_CAPABILITIES, arrayParams: false } });
    await repo.all(
      from(Author, "a").preload("books", (q) => q.select(({ books }) => books).preload("chapters")),
    );
    expect(tables(driver)).toEqual(["authors", "books", "chapters"]);
    await repo.all(from(Author, "a").preload("books", (q) => q.offset(1)));
    expect(driver.statements.at(-1)?.sql).toContain('where "$books__ranked"."$rank" > $4 order by');
    await repo.all(from(Author, "a").preload("books", (q) => q.limit(1)));
    expect(driver.statements.at(-1)?.sql).toContain('"books"."author_id" in ($1, $2, $3)');
  });

  test("named values reach the statements that use them only, with and without listeners", async () => {
    const { adapter, driver } = setup();
    const repo = createRepo({ adapter });
    const query = from(Author, "a")
      .where(({ a }) => a.id.lt(param("max", t.integer())))
      .preload(["bio", "books"]);
    await repo.all(query, { max: 9 });
    expect(driver.statements.map((statement) => statement.params)).toEqual([[9], [[1, 2, 3]], [[1, 2, 3]]]);
    driver.respond = (sql) => (tableOf(sql) === "bios" ? new Error("down") : answer(sql));
    await expect(repo.all(query, { max: 9 })).rejects.toThrow("down");
    const events: RepoQueryEvent[] = [];
    repo.on("query", (event) => events.push(event));
    await expect(repo.all(query, { max: 9 })).rejects.toThrow("down");
    expect(events.map((event) => event.operation)).toEqual(["all", "preload"]);
  });

  test("reload: what each row was loaded with, callbacks included, under one budget", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql, params) => {
      if (sql.includes('"$keys"')) {
        return (params[0] as number[]).map((id, i) => ({
          ...raw(Author, DATA.authors?.find((row) => row.id === id) ?? {}),
          c2: i + 1,
        }));
      }
      if (tableOf(sql) === "books" && !sql.includes('"id" as')) return [{ c0: 1, c1: "Engines" }];
      return answer(sql);
    };
    const shaped = await repo.all(
      from(Author, "a").preload("books", (q) =>
        q.select(({ books }) => ({ authorId: books.authorId, title: books.title })),
      ),
    );
    const linus = await repo.all(
      from(Author, "a")
        .where(({ a }) => a.id.eq(3))
        .preload("bio"),
    );
    driver.statements.length = 0;
    const fresh = (await repo.reload([...shaped, ...linus] as object[], { timeoutMs: 5_000 })) as {
      books: unknown[];
    }[];
    // The callback's select is applied again.
    expect(fresh[0]?.books[0]).toEqual({ authorId: 1, title: "Engines" });
    expect(tables(driver)).toEqual(["authors", "books", "bios"]);
  });

  test("reload: a level loaded empty is loaded with its nested preloads", async () => {
    const { repo, driver } = fake();
    let linusHasABook = false;
    driver.respond = (sql, params) => {
      if (sql.includes('"$keys"')) {
        return (params[0] as number[]).map((id, i) => ({
          ...raw(Author, DATA.authors?.find((row) => row.id === id) ?? {}),
          c2: i + 1,
        }));
      }
      if (tableOf(sql) === "authors") return [raw(Author, { id: 3, name: "Linus" })];
      if (tableOf(sql) === "books")
        return linusHasABook ? [raw(Book, { id: 40, authorId: 3, title: "New" })] : [];
      return answer(sql);
    };
    const [linus] = await repo.all(
      from(Author, "a")
        .where(({ a }) => a.id.eq(3))
        .preload({ books: "chapters" }),
    );
    expect(linus?.books).toEqual([]);
    linusHasABook = true;
    const fresh = await repo.reloadOrThrow(linus as Author & { books: (Book & { chapters: Chapter[] })[] });
    expect(fresh.books[0]?.chapters).toEqual([]);
    // Reloaded again: the reloaded row carries the record too.
    const again = await repo.reloadOrThrow(fresh);
    expect(again.books[0]?.chapters).toEqual([]);
  });

  test("reload: a row with no record is reloaded with what it shows, as whole rows", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql, params) =>
      sql.includes('"$keys"')
        ? (params[0] as number[]).map((id, i) => ({
            ...raw(Author, DATA.authors?.find((row) => row.id === id) ?? {}),
            c2: i + 1,
          }))
        : answer(sql);
    const authorMeta = meta(Author);
    // As a write returns a row with its associations kept: no record of how they were loaded.
    const handMade = authorMeta.createWith(["books"])(
      [1, "Ada"],
      [[{ authorId: 1, title: "Engines" }]],
      authorMeta.rowMeta("loaded", undefined),
    ) as Author & { books: unknown[] };
    const fresh = (await repo.reloadOrThrow(handMade)) as { books: unknown[] };
    expect(fresh.books[0]).toBeInstanceOf(Book);
    // Loaded rows show what is below them; an empty level shows nothing below it.
    const [book] = await repo.all(from(Book, "b").preload("chapters"));
    const bookMeta = meta(Book);
    const withBook = authorMeta.createWith(["bio", "books"])(
      [1, "Ada"],
      [
        null,
        [
          bookMeta.createWith(["chapters"])(
            [10, 1, "Engines", null],
            [(book as { chapters: unknown[] }).chapters],
            bookMeta.rowMeta("loaded", undefined),
          ),
        ],
      ],
      authorMeta.rowMeta("loaded", undefined),
    ) as Author & { books: (Book & { chapters: Chapter[] })[] };
    driver.statements.length = 0;
    const deeper = await repo.reloadOrThrow(withBook);
    expect(deeper.books[0]?.chapters).toHaveLength(2);
    expect(tables(driver)).toEqual(["authors", "bios", "books", "chapters"]);
  });

  test("a to-one join child present on the first row and missing on a later one is kept", async () => {
    const { repo, driver } = fake();
    driver.respond = () => [
      { ...raw(Book, DATA.books?.[0] ?? {}), ...raw(Author, DATA.authors?.[0] ?? {}, 4) },
      { ...raw(Book, DATA.books?.[0] ?? {}), ...raw(Author, {}, 4) },
    ];
    const books = await repo.all(from(Book, "b").leftJoinAssoc("b", "author", "a").preload({ author: "a" }));
    expect(books[0]?.author?.name).toBe("Ada");
  });

  test("assoc() of rows with null and repeated keys, and the errors' wording", async () => {
    const { repo, driver } = fake();
    const books = await repo.all(from(Book, "b"));
    driver.statements.length = 0;
    await repo.all(assoc(Book, books, "author"));
    expect(driver.statements[0]?.params).toEqual([[1, 2]]);
    const authors = await repo.all(from(Author, "a"));
    expect(() => assoc(Author, [authors[0], null] as never, "books")).toThrow("element 1 is null");
    expect(() => assoc(Author, [7] as never, "books")).toThrow("it was given number");
    expect(() => assoc(Author, books[0] as never, "books")).toThrow("but the row is a row of Book");
    const stray = Object.create(null) as Record<symbol, unknown>;
    stray[ROW] = { state: "loaded" };
    expect(() => assoc(Author, [stray, stray] as never, "books")).toThrow("element 0 is a row of no schema");
    expect(() => isLoaded(Label, books[0] as never, "x" as never)).toThrow("Its associations are: none");
  });

  test("KeyIndex: values of other kinds are compared with their type's equal", () => {
    const binary = meta(Blob).fieldsByName.get("data")?.type;
    const index = new KeyIndex<number>([binary as never]);
    index.set([new Uint8Array([1])], 1);
    index.set([new Uint8Array([2])], 2);
    index.set([new Uint8Array([1])], 3);
    expect(index.get([new Uint8Array([1])])).toBe(3);
    expect(index.get([new Uint8Array([2])])).toBe(2);
    const custom = defineType<string, string>({
      name: "code",
      db: { kind: "custom", sql: "citext" },
      cast: (input) => ({ success: true, data: String(input) }),
      fromDb: (value) => value,
      toDb: (value) => value,
      equal: (a, b) => a.toLowerCase() === b.toLowerCase(),
    });
    const codes = new KeyIndex<number>([custom as never, meta(Blob).fieldsByName.get("day")?.type as never]);
    codes.set(["AB", "2026-01-01"], 1);
    expect(codes.get(["ab", "2026-01-01"])).toBe(1);
    expect(codes.get(["ab", "2026-01-02"])).toBeUndefined();
    const single = new KeyIndex<number>([custom as never]);
    single.set(["AB"], 1);
    single.set(["CD"], 2);
    single.set(["ab"], 3);
    expect(single.get(["Ab"])).toBe(3);
    expect(single.get(["cd"])).toBe(2);
    expect(single.get(["zz"])).toBeUndefined();
  });
});

// --- review round 1 -------------------------------------------------------------------

class AuthAuthor extends Schema("authors", { id: t.integer().primaryKey() }, { schema: "auth" }) {
  static books = hasMany(() => Book, { foreignKey: "authorId" });
}

class Rack extends Schema("racks", { region: t.string().primaryKey(), code: t.integer().primaryKey() }) {
  static slots = hasMany(() => Slot, { foreignKey: ["rackRegion", "rackCode"] });
  static items = hasMany(() => Item, { through: ["slots", "items"] });
}

class Slot extends Schema("slots", {
  id: t.integer().primaryKey(),
  rackRegion: t.string(),
  rackCode: t.integer(),
}) {
  static items = hasMany(() => Item, { foreignKey: "slotId" });
}

class Item extends Schema("items", { id: t.integer().primaryKey(), slotId: t.integer() }) {}

class Vault extends Schema("vaults", { id: t.integer().primaryKey().redact() }) {
  static coins = hasMany(() => Coin, { foreignKey: "vaultId" });
}

class Coin extends Schema("coins", { id: t.integer().primaryKey(), vaultId: t.integer() }) {
  static vault = belongsTo(() => Vault, { foreignKey: "vaultId" });
}

class Case extends Schema("cases", { a: t.integer().primaryKey(), b: t.integer().primaryKey().redact() }) {
  static parts = hasMany(() => Part, { foreignKey: ["caseA", "caseB"] });
}

class Part extends Schema("parts", {
  id: t.integer().primaryKey(),
  caseA: t.integer(),
  caseB: t.integer(),
}) {}

class Ledger extends Schema("ledgers", { amount: t.decimal().primaryKey() }) {
  static entries = hasMany(() => Entry, { foreignKey: "amount" });
}

class Entry extends Schema("entries", { id: t.integer().primaryKey(), amount: t.decimal() }) {}

describe("review round 1", () => {
  test("children of a parent whose class declares a database schema are read with the call's", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => (tableOf(sql) === "authors" ? [{ c0: 1 }] : []);
    await repo.all(from(AuthAuthor, "a").preload("books"));
    expect(driver.statements[0]?.sql).toContain('from "auth"."authors"');
    expect(driver.statements[1]?.sql).toContain('from "books" as "books"');
    await repo.all(from(AuthAuthor, "a").preload("books"), { schema: "tenant" });
    expect(driver.statements[3]?.sql).toContain('from "tenant"."books"');
    await repo.all(from(AuthAuthor, "a").schema("q").preload("books"));
    expect(driver.statements[5]?.sql).toContain('from "q"."books"');
    const scoped = fake();
    const withDefault = createRepo({ adapter: scoped.adapter, schema: "tenant" });
    scoped.driver.respond = (sql) => (tableOf(sql) === "authors" ? [{ c0: 1 }] : []);
    const authors = await withDefault.all(from(AuthAuthor, "a"));
    await withDefault.preload(AuthAuthor, authors, "books");
    expect(scoped.driver.statements[1]?.sql).toContain('from "tenant"."books"');
  });

  test("repo.preload refuses a schema option", async () => {
    const { repo } = fake();
    await expect(repo.preload(Author, [], "books", { schema: "x" } as never)).rejects.toThrow(
      "repo.preload() takes no schema option",
    );
  });

  test("assoc() through a has-through filters on every part of a composite key", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) => (tableOf(sql) === "racks" ? [{ c0: "n", c1: 1 }] : []);
    const racks = await repo.all(from(Rack, "r"));
    driver.statements.length = 0;
    await repo.all(assoc(Rack, racks, "items"));
    expect(driver.statements[0]?.sql).toContain('where "owner"."region" = $1 and "owner"."code" = $2');
    expect(driver.statements[0]?.params).toEqual(["n", 1]);
  });

  test("KeyIndex: decimals by their normalised digits, bytes by their hex", () => {
    const decimal = meta(Ledger).fieldsByName.get("amount")?.type as never;
    const index = new KeyIndex<number>([decimal]);
    index.set(["1.50"], 1);
    expect(index.get(["1.5"])).toBe(1);
    expect(index.get(["01.500"])).toBe(1);
    expect(index.get(["1.05"])).toBeUndefined();
    index.set(["-0.0"], 2);
    expect(index.get(["0"])).toBe(2);
    expect(index.get([".0"])).toBe(2);
    index.set(["-2.10"], 3);
    expect(index.get(["-2.1"])).toBe(3);
    index.set(["0.50"], 6);
    expect(index.get([".5"])).toBe(6);
    index.set(["NaN"], 4);
    expect(index.get(["NaN"])).toBe(4);
    const bytes = new KeyIndex<number>([meta(Blob).fieldsByName.get("data")?.type as never]);
    bytes.set([new Uint8Array([0, 255])], 5);
    expect(bytes.get([new Uint8Array([0, 255])])).toBe(5);
    expect(bytes.get([new Uint8Array([255, 0])])).toBeUndefined();
  });

  test("a rescaled decimal key still finds its children", async () => {
    const { repo, driver } = fake();
    driver.respond = (sql) =>
      tableOf(sql) === "ledgers"
        ? [{ c0: "1.50" }]
        : [
            { c0: 1, c1: "1.5" },
            { c0: 2, c1: "1.500" },
          ];
    const ledgers = await repo.all(from(Ledger, "l").preload("entries"));
    expect(ledgers[0]?.entries.map((entry) => entry.id)).toEqual([1, 2]);
  });

  test("a limit, an offset or repo.first with a to-many join preload is refused before anything runs", async () => {
    const { repo, driver } = fake();
    const joined = from(Author, "a").leftJoinAssoc("a", "books", "b").preload({ books: "b" });
    await expect(repo.first(joined)).rejects.toThrow(
      "repo.first() (which adds a limit) would count the joined rows",
    );
    await expect(repo.all(joined.limit(1))).rejects.toThrow('preloads "books" from a join');
    await expect(repo.all(joined.offset(1))).rejects.toThrow("a limit or an offset");
    const deep = from(Book, "b")
      .leftJoinAssoc("b", "author", "a")
      .leftJoinAssoc("a", "books", "o")
      .preload({ author: { $from: "a", books: "o" } });
    await expect(repo.first(deep)).rejects.toThrow('preloads "books" from a join');
    expect(driver.statements).toEqual([]);
    // A to-one join preload, and separate preloads, may be limited.
    driver.respond = () => [];
    await repo.first(
      from(Book, "b").leftJoinAssoc("b", "author", "a").preload({ author: "a", labels: true }),
    );
    await repo.all(from(Author, "a").preload("books").limit(1));
    expect(driver.statements).toHaveLength(2);
  });

  test("a key is redacted when the field on either side is", async () => {
    const lines: string[] = [];
    const { adapter, driver } = setup();
    const repo = createRepo({ adapter, log: { params: true } });
    repo.on("query", (event) => lines.push(JSON.stringify(event.params)));
    driver.respond = (sql) =>
      tableOf(sql) === "vaults"
        ? [{ c0: 7 }]
        : tableOf(sql) === "coins"
          ? [{ c0: 1, c1: 7 }]
          : tableOf(sql) === "cases"
            ? [{ c0: 1, c1: 2 }]
            : [];
    await repo.all(from(Vault, "v").preload("coins"));
    await repo.all(from(Coin, "c").preload("vault"));
    await repo.all(from(Case, "c").preload("parts"));
    expect(lines).toEqual(["[]", '["**redacted**"]', "[]", '["**redacted**"]', "[]", '[[1],"**redacted**"]']);
  });

  test("after a statement fails, no waiting statement starts", async () => {
    const { repo, driver } = fake();
    driver.delayMs = 20;
    driver.respond = (sql) => (tableOf(sql) === "bios" ? new Error("down") : answer(sql));
    await expect(
      repo.all(from(Author, "a").preload(["bio", "books", "notes"]), { maxConcurrency: 2 }),
    ).rejects.toThrow("down");
    // Let anything that would still start reach the driver.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(tables(driver)).toEqual(["authors", "bios", "books"]);
  });

  test("a decoding failure stops the run too, with or without listeners", async () => {
    const failing = defineType<number, unknown>({
      name: "failing",
      db: { kind: "integer" },
      cast: () => ({ success: false }),
      fromDb: () => {
        throw new Error("cannot decode");
      },
      toDb: (value) => value,
      equal: Object.is,
    });
    class Bad extends Schema("bad", {
      id: t.integer().primaryKey(),
      ownerId: t.integer(),
      v: t.type(failing),
    }) {}
    class Holder extends Schema("holders", { id: t.integer().primaryKey() }) {
      static bad = hasMany(() => Bad, { foreignKey: "ownerId" });
      static more = hasMany(() => Bad, { foreignKey: "ownerId" });
      static rest = hasMany(() => Bad, { foreignKey: "ownerId" });
    }
    for (const listen of [false, true]) {
      const { adapter, driver } = setup();
      const repo = createRepo({ adapter });
      if (listen) repo.on("query", () => {});
      driver.delayMs = 10;
      driver.respond = (sql) => (tableOf(sql) === "holders" ? [{ c0: 1 }] : [{ c0: 1, c1: 1, c2: 5 }]);
      await expect(
        repo.all(from(Holder, "h").preload(["bad", "more", "rest"]), { maxConcurrency: 2 }),
      ).rejects.toThrow("cannot decode");
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(driver.statements).toHaveLength(3);
    }
  });
});
