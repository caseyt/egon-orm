// Every statement of the SQL snapshot matrices, executed on a dialect's database through
// its adapter: the statement text, its `?` placeholders and the bound parameters (encoded
// by the adapter's own codecs) must be accepted. Results are not asserted here (the
// snapshot tests pin the text); a few realistic queries check their rows. Each statement
// runs in a transaction that is rolled back, so writes do not affect the next one. Cases
// whose expected output for the dialect is a refusal are compiled, not run: the snapshot
// tests check their QueryError.
import type { Connection, DatabaseAdapter } from "egon-orm";
import { cte, from, rowNumber, subquery } from "egon-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MYSQL, POSTGRES, SQLITE } from "../../../src/compiler/advanced/advanced-cases.js";
import { ADVANCED_QUERIES, Category } from "../../../src/compiler/advanced/advanced-queries.js";
import { bindParams, type NamedValues } from "../../../src/compiler/bind.js";
import { type Compiler, createCompiler } from "../../../src/compiler/compiler.js";
import type { SqlDialect } from "../../../src/compiler/dialect.js";
import { ALL_CASES } from "../../../src/compiler/sql-cases.js";
import type { QueryLike } from "../../../src/query/builder.js";
import {
  createTestDatabase,
  Post,
  type TestDatabase,
  type TestDatabaseHandle,
  User,
} from "../../support/index.js";

export interface CompilerConformanceProfile {
  /** Shown in the suite's name. */
  readonly label: string;
  /** The test server's dialect, for `createTestDatabase`. */
  readonly server: TestDatabase["dialect"];
  /** The compiler's SQL table for the dialect. */
  readonly sqlDialect: SqlDialect;
  /** Creates the adapter under test, connected to `db`. */
  readonly makeAdapter: (db: TestDatabase) => DatabaseAdapter;
  /**
   * Adds what the matrices need beyond the blog fixture, on the adapter's own connection
   * (a SQLite database schema is an attached database of that handle): the `events`,
   * `categories` and `audit.audit_logs` tables, and copies of `users` and `posts` in the
   * database schemas `tenant_1` and `archive`. The suite adds the rows.
   */
  readonly prepare: (db: TestDatabase, connection: Connection) => Promise<void>;
  /** Removes what `prepare` made outside the test database (MySQL's databases); runs when the suite ends. */
  readonly cleanup?: ((connection: Connection) => Promise<void>) | undefined;
  /** A timestamp literal of the seed, from an ISO 8601 instant in UTC. */
  readonly timestamp: (iso: string) => string;
  /** Statements that make the next generated id of `users`, `posts`, `tags` and `categories` 101. */
  readonly restartIds: readonly string[];
}

/**
 * The seed rows, one statement each (booleans as 1 / 0, arrays as JSON text, which every
 * dialect accepts), with `timestamp` writing the dialect's literal.
 */
function seed(timestamp: (iso: string) => string): readonly string[] {
  const at = (day: string) => timestamp(`${day}T00:00:00.000Z`);
  return [
    `insert into users (id, email, name, age, role, settings) values
      (1, 'ann@example.com', 'Ann', 34, 'admin', '{"theme": "dark", "tags": ["a", "b"]}'),
      (2, 'bo@example.com', null, 15, 'member', null),
      (3, 'cy@example.com', 'Cy', 41, 'member', '{"theme": "light"}'),
      (4, 'di@example.com', 'Di', 28, 'member', null)`,
    "insert into profiles (user_id, bio) values (1, 'hello')",
    `insert into posts (id, author_id, title, published, views, tags, published_at, created_at) values
      (1, 1, 'Ann one', 1, 120, '["ts", "orm"]', ${at("2026-02-01")}, ${at("2026-02-01")}),
      (2, 1, 'Ann two', 0, 3, '["sql"]', null, ${at("2026-03-01")}),
      (3, 1, 'Ann three', 1, 50, null, null, ${at("2026-04-01")}),
      (4, 1, 'Ann four', 1, 7, null, null, ${at("2026-05-01")}),
      (5, 2, 'Bo one', 1, 9, null, null, ${at("2026-02-15")}),
      (6, 3, 'Cy one', 0, 0, null, null, ${at("2025-12-01")})`,
    "insert into comments (post_id, author_id, body) values (1, 2, 'nice'), (2, null, 'anon'), (6, 1, 'old')",
    "insert into tags (id, name) values (1, 'ts'), (2, 'sql')",
    "insert into posts_tags (post_id, tag_id) values (1, 1), (2, 2)",
    "insert into orgs (name) values ('Acme')",
    "insert into memberships (org_id, user_id) select id, 1 from orgs",
    `insert into events (name, payload) values ('signup', '{"plan": "free"}')`,
    `insert into categories (id, parent_id, name) values
      (1, null, 'root'), (2, 1, 'child a'), (3, 1, 'child b'), (4, 2, 'grandchild'), (5, null, 'other root')`,
  ];
}

/** The expected output of the step 09 matrix per dialect: a refused query is not run. */
const ADVANCED_EXPECTED = { postgres: POSTGRES, mysql: MYSQL, sqlite: SQLITE } as const;

/** The ids of `users` 1..4 and `posts` 1..6 that the seed writes; later inserts start at 101. */
export const SEEDED = { users: 4, posts: 6 } as const;

/**
 * Runs every case of the SQL snapshot matrices and of the step 09 matrix on the profile's
 * database, and a few queries whose rows are checked.
 *
 * @example
 * ```ts
 * describe.runIf(tier2Enabled())("mysql", () => runCompilerConformance(MYSQL_COMPILER_PROFILE));
 * ```
 */
export function runCompilerConformance(profile: CompilerConformanceProfile): void {
  describe(`compiler conformance: ${profile.label}`, () => {
    let handle: TestDatabaseHandle;
    let adapter: DatabaseAdapter;
    let connection: Connection;
    let compiler: Compiler;

    beforeAll(async () => {
      handle = await createTestDatabase(profile.server, { label: "compiler", fixtures: ["blog"] });
      adapter = profile.makeAdapter(handle.db);
      compiler = createCompiler(
        { ...profile.sqlDialect, capabilities: adapter.capabilities },
        { codecs: adapter },
      );
      connection = await adapter.acquire();
      await profile.prepare(handle.db, connection);
      for (const statement of [...seed(profile.timestamp), ...profile.restartIds]) {
        await connection.execute(statement, []);
      }
    });

    afterAll(async () => {
      if (connection !== undefined) await profile.cleanup?.(connection);
      await connection?.release();
      await adapter?.close();
      await handle?.drop();
    });

    /** Runs a compiled statement in a transaction that is rolled back; returns its rows. */
    async function rolledBack(
      sql: string,
      params: readonly unknown[],
    ): Promise<readonly Record<string, unknown>[]> {
      await connection.begin();
      try {
        return (await connection.execute(sql, params)).rows;
      } finally {
        await connection.rollback();
      }
    }

    async function rows(query: QueryLike, named?: NamedValues): Promise<readonly Record<string, unknown>[]> {
      const plan = compiler.compile(query.ast, "all", undefined);
      return (await connection.execute(plan.sql, bindParams(plan.slots, query.ast.params, named))).rows;
    }

    for (const [area, cases] of ALL_CASES) {
      describe(`${area} statements run`, () => {
        for (const sqlCase of cases) {
          const expected = sqlCase.expected[profile.sqlDialect.name];
          if (expected === undefined || "error" in expected) continue;
          test(sqlCase.name, async () => {
            const plan = sqlCase.compile(compiler);
            const params = bindParams(plan.slots, sqlCase.params, sqlCase.named);
            expect(Array.isArray(await rolledBack(plan.sql, params))).toBe(true);
          });
        }
      });
    }

    describe("step 09 statements run", () => {
      for (const entry of ADVANCED_QUERIES) {
        const expected = ADVANCED_EXPECTED[profile.sqlDialect.name][entry.name];
        if (expected === undefined || "error" in expected) continue;
        test(entry.name, async () => {
          const plan = compiler.compile(entry.query.ast, entry.operation, undefined);
          const params = bindParams(plan.slots, entry.query.ast.params, entry.named);
          expect(Array.isArray(await rolledBack(plan.sql, params))).toBe(true);
        });
      }
    });

    test("a list in in() is expanded to one placeholder per element and filters as a list", async () => {
      const q = from(User, "u")
        .where(({ u }) => u.id.in([1, 3, 99]))
        .orderBy(({ u }) => u.id)
        .select(({ u }) => u.id);
      const plan = compiler.compile(q.ast, "all", undefined);
      expect(plan.sql).toContain("in (?, ?, ?)");
      expect((await rows(q)).map((row) => Number(row.c0))).toEqual([1, 3]);
    });

    test("an in() list at the parameter limit runs; one more element is refused before it reaches the database", async () => {
      const max = adapter.capabilities.maxParams;
      const ids = Array.from({ length: max }, (_, i) => i + 1);
      const atLimit = from(User, "u")
        .where(({ u }) => u.id.in(ids))
        .select(({ u }) => u.id);
      expect((await rows(atLimit)).length).toBe(SEEDED.users);
      const over = from(User, "u")
        .where(({ u }) => u.id.in([...ids, max + 1]))
        .select(({ u }) => u.id);
      expect(() => compiler.compile(over.ast, "all", undefined)).toThrow(
        new RegExp(`more than the ${max} ${profile.sqlDialect.name} accepts`),
      );
    });

    test("top posts per author by views, with a window function in a subquery", async () => {
      const ranked = from(Post, "p").select(({ p }) => ({
        id: p.id,
        authorId: p.authorId,
        rn: rowNumber().over({ partitionBy: [p.authorId], orderBy: [p.views.desc(), p.id] }),
      }));
      const top = from(subquery(ranked), "r")
        .where(({ r }) => r.rn.lte(2))
        .orderBy(({ r }) => [r.authorId, r.rn])
        .select(({ r }) => ({ id: r.id, rank: r.rn }));
      expect((await rows(top)).map((row) => [Number(row.c0), Number(row.c1)])).toEqual([
        [1, 1],
        [3, 2],
        [5, 1],
        [6, 1],
      ]);
    });

    test("a recursive category tree from its root", async () => {
      const roots = from(Category, "c").where(({ c }) => c.id.eq(1));
      const children = from(Category, "c").join(cte("tree", Category), "t", ({ c, t }) =>
        c.parentId.eq(t.id),
      );
      const tree = from(cte("tree", Category), "t")
        .withCte("tree", roots.unionAll(children), { recursive: true })
        .orderBy(({ t }) => t.id)
        .select(({ t }) => t.name);
      expect((await rows(tree)).map((row) => row.c0)).toEqual(["root", "child a", "child b", "grandchild"]);
    });

    test("the plan cache shared by every statement above saw no collision", () => {
      expect(compiler.stats().collisions).toBe(0);
      expect(compiler.stats().misses).toBeGreaterThan(100);
    });
  });
}
