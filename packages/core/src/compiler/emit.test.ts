import { Post, Tag, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { Capabilities } from "../contracts/adapter.js";
import type { ExprNode, QueryAst } from "../contracts/query.js";
import type { FieldMeta } from "../contracts/schema.js";
import { defineType, fragment, from, param, t } from "../index.js";
import {
  aggregateNode,
  binaryNode,
  caseNode,
  castNode,
  fnNode,
  jsonPathNode,
  listNode,
  literalNode,
  naryNode,
  orderNode,
  paramNode,
  tupleNode,
  unaryNode,
  windowNode,
} from "../query/ast.js";
import { meta } from "../schema/index.js";
import { bindParams, wholeBigintNumber } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { POSTGRES_CAPABILITIES, postgresDialect, type SqlDialect } from "./dialect.js";
import { precedenceOf } from "./emit.js";
import { PRECEDENCE, registerNodeEmitter } from "./registry.js";
import { ALL_CASES } from "./sql-cases.js";
import {
  bareQuery,
  col,
  DIALECTS,
  frag,
  rebuild,
  run,
  selectOne,
  tableOf,
  typeOf,
  value,
  withDialects,
} from "./sql-fixtures.js";

/** A dialect like Postgres with some capabilities taken away, named after another database. */
function limited(capabilities: Partial<Capabilities>, rest: Partial<SqlDialect> = {}): SqlDialect {
  return {
    ...postgresDialect,
    name: "sqlite",
    capabilities: { ...POSTGRES_CAPABILITIES, ...capabilities },
    ...rest,
  };
}

/** A dialect with `?` placeholders that expands lists. */
const positional: SqlDialect = limited({ arrayParams: false }, { name: "mysql", placeholder: "positional" });

function sql(dialect: SqlDialect, ast: QueryAst | { readonly ast: QueryAst }): string {
  return createCompiler(dialect).compile("kind" in ast ? ast : ast.ast, "all", undefined).sql;
}

function where(expr: ExprNode): QueryAst {
  return rebuild(from(User, "u").ast, {
    wheres: [{ kind: "bool", op: "and", expr }],
    select: selectOne(col("u", "id")),
  });
}

function selecting(expr: ExprNode): QueryAst {
  return rebuild(from(User, "u").ast, { select: selectOne(expr) });
}

describe("determinism", () => {
  test("the same AST compiles to byte-identical SQL and slots in two compilers", () => {
    for (const [, cases] of ALL_CASES) {
      for (const sqlCase of cases) {
        const a = sqlCase.compile(createCompiler(postgresDialect));
        const b = sqlCase.compile(createCompiler(postgresDialect));
        expect(a.sql).toBe(b.sql);
        expect(a.slots).toEqual(b.slots);
      }
    }
  });
});

describe("placeholders and slots", () => {
  test("numbered placeholders follow the text; slots point at canonical positions", () => {
    // The select list is written before WHERE, but its value comes after WHERE's in canonical order.
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(18))
      .select(({ u }) => ({ id: u.id, minimum: param("minimum", t.integer()) }))
      .limit(5);
    const plan = createCompiler(postgresDialect).compile(q.ast, "all", undefined);
    expect(plan.sql).toBe(
      'select "u"."id" as "c0", cast($1 as integer) as "c1" from "users" as "u" where "u"."age" >= $2 limit $3',
    );
    expect(plan.slots.map((slot) => (slot.kind === "named" ? slot.name : slot.index))).toEqual([
      "minimum",
      0,
      1,
    ]);
    expect(bindParams(plan.slots, q.ast.params, { minimum: 3 })).toEqual([3, 18, 5]);
  });

  test("positional placeholders: slots are in text order, a list expands to one per element", () => {
    const q = from(User, "u")
      .where(({ u }) => u.id.in([4, 5, 6]))
      .where(({ u }) => u.role.notIn(["admin"]))
      .select(({ u }) => ({ id: u.id, label: param("label", t.string()) }));
    const plan = createCompiler(positional).compile(q.ast, "all", undefined);
    expect(plan.sql).toBe(
      'select "u"."id" as "c0", cast(? as text) as "c1" from "users" as "u" where "u"."id" in (?, ?, ?) and "u"."role" not in (?)',
    );
    expect(plan.slots).toEqual([
      { kind: "named", name: "label", toDb: undefined, redact: false },
      // User.id is a bigint({ mode: "number" }): its values are checked to be whole numbers.
      { kind: "element", index: 0, element: 0, toDb: wholeBigintNumber, redact: false },
      { kind: "element", index: 0, element: 1, toDb: wholeBigintNumber, redact: false },
      { kind: "element", index: 0, element: 2, toDb: wholeBigintNumber, redact: false },
      { kind: "element", index: 1, element: 0, toDb: undefined, redact: false },
    ]);
    expect(bindParams(plan.slots, q.ast.params, { label: "x" })).toEqual(["x", 4, 5, 6, "admin"]);
  });

  test("an empty expanded list is false (or true for not in) and skips its subject's values", () => {
    const empty = listNode([], typeOf(t.integer()), false);
    const subject = binaryNode("add", col("u", "age"), value(1));
    const q = rebuild(
      where(naryNode("and", [binaryNode("in", subject, empty), binaryNode("eq", col("u", "id"), value(9))])),
      {},
    );
    const plan = createCompiler(positional).compile(q, "all", undefined);
    expect(plan.sql).toBe('select "u"."id" as "c0" from "users" as "u" where false and "u"."id" = ?');
    expect(bindParams(plan.slots, q.params)).toEqual([9]);
    expect(sql(positional, where(binaryNode("notIn", col("u", "id"), empty)))).toContain("where true");
  });

  test("a list outside in() needs array parameters", () => {
    const ast = selecting(listNode([1], undefined, false));
    expect(() => sql(positional, ast)).toThrow(
      "A list of values outside in() needs array parameters, which mysql does not have.",
    );
    expect(sql(postgresDialect, ast)).toBe('select $1 as "c0" from "users" as "u"');
  });

  test("has() writes its element first, keeping canonical positions", () => {
    const left = fnNode("arrayAppend", [col("p", "tags"), value("a")]);
    const ast = rebuild(from(Post, "p").ast, {
      wheres: [{ kind: "bool", op: "and", expr: binaryNode("has", left, value("b")) }],
      select: selectOne(col("p", "id")),
    });
    const plan = createCompiler(postgresDialect).compile(ast, "all", undefined);
    expect(plan.sql).toBe(
      'select "p"."id" as "c0" from "posts" as "p" where $1 = any(array_append("p"."tags", $2))',
    );
    expect(bindParams(plan.slots, ast.params)).toEqual(["b", "a"]);
  });

  test("a placeholder next to a word in a fragment stays a token of its own", () => {
    const ast = where(frag`length(x)=${value(1)}0 and a${value(2)} and $${value(3)}`);
    const plan = createCompiler(postgresDialect).compile(ast, "all", undefined);
    expect(plan.sql).toContain("where length(x)=$1 0 and a $2 and $ $3");
  });

  test("a typed parameter in a fragment is cast; an untyped one is not", () => {
    const ast = where(frag`${value(1, typeOf(t.integer()))} < ${value(2)}`);
    expect(sql(postgresDialect, ast)).toContain("where cast($1 as integer) < $2");
  });

  test("toDb comes from the adapter's override when it has one", () => {
    const upper = (v: unknown) => String(v).toUpperCase();
    const compiler = createCompiler(postgresDialect, {
      codecs: {
        typeOverrides: (type) => (type.name === "string" ? { fromDb: (v) => v, toDb: upper } : undefined),
      },
    });
    const q = from(User, "u")
      .where(({ u }) => u.email.eq("a@b.c"))
      .select(({ u }) => u.id);
    const plan = compiler.compile(q.ast, "all", undefined);
    expect(plan.slots[0]?.toDb).toBe(upper);
    expect(bindParams(plan.slots, q.ast.params)).toEqual(["A@B.C"]);
  });

  test("the parameter limit is enforced", () => {
    const tiny = limited({ maxParams: 2 });
    const q = from(User, "u")
      .where(({ u }) => u.id.in([1, 2, 3]))
      .where(({ u }) => u.age.gt(1));
    expect(() => sql(tiny, q)).not.toThrow();
    expect(() => sql(tiny, q.limit(1))).toThrow(
      "The statement has 3 parameters, more than the 2 sqlite accepts. Split it into smaller statements.",
    );
  });

  test("params that disagree with the tree are refused", () => {
    const ast = { ...where(binaryNode("eq", col("u", "id"), value(1))), params: [] };
    expect(() => sql(postgresDialect, ast)).toThrow(
      "The query's params hold 0 values, but its parameter nodes hold 1. Build queries with from(), or compute params with collectParams.",
    );
  });

  test("a named parameter needs a name", () => {
    expect(() =>
      sql(postgresDialect, selecting({ kind: "namedParam", name: "", type: undefined, redact: false })),
    ).toThrow("A named parameter has no name.");
  });
});

describe("capabilities", () => {
  const users = from(User, "u");
  const posts = from(Post, "p");
  const cases: readonly (readonly [string, Partial<Capabilities>, () => unknown, string])[] = [
    [
      "fullJoin",
      { fullJoin: false },
      () =>
        sql(
          limited({ fullJoin: false }),
          users.fullJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id)),
        ),
      "FULL JOIN is not supported by sqlite.",
    ],
    [
      "lateralJoin",
      { lateralJoin: false },
      () =>
        sql(
          limited({ lateralJoin: false }),
          rebuild(users.ast, {
            joins: [
              {
                kind: "join",
                type: "leftLateral",
                source: { kind: "subquerySource", query: posts.ast, alias: "s" },
                on: literalNode(true),
              },
            ],
          }),
        ),
      "LATERAL JOIN is not supported by sqlite.",
    ],
    [
      "distinctOn",
      { distinctOn: false },
      () =>
        sql(
          limited({ distinctOn: false }),
          users.distinct(({ u }) => u.role),
        ),
      "DISTINCT ON is not supported by sqlite.",
    ],
    [
      "ilike",
      { ilike: false },
      () =>
        sql(
          limited({ ilike: false }),
          users.where(({ u }) => u.email.ilike("a")),
        ),
      "ILIKE is not supported by sqlite.",
    ],
    [
      "arrays (has)",
      { arrays: false },
      () =>
        sql(
          limited({ arrays: false }),
          posts.where(({ p }) => p.tagList.has("a")),
        ),
      "has() (array membership) is not supported by sqlite.",
    ],
    [
      "arrays (in an array)",
      { arrays: false },
      () => sql(limited({ arrays: false }), where(binaryNode("in", value(1), col("u", "id")))),
      "in() with an array expression is not supported by sqlite.",
    ],
    [
      "arrays and jsonb (contains)",
      { arrays: false, jsonb: false },
      () =>
        sql(
          limited({ arrays: false, jsonb: false }),
          posts.where(({ p }) => p.tagList.contains(["a"])),
        ),
      "The contains() operator is not supported by sqlite.",
    ],
    [
      "nullsOrder",
      { nullsOrder: false },
      () =>
        sql(
          limited({ nullsOrder: false }),
          users.orderBy(({ u }) => u.name.asc().nullsLast()),
        ),
      "NULLS FIRST / NULLS LAST is not supported by sqlite.",
    ],
    [
      "cteMaterialized",
      { cteMaterialized: false },
      () =>
        sql(
          limited({ cteMaterialized: false }),
          rebuild(users.ast, {
            ctes: [
              {
                kind: "cte",
                name: "c",
                query: posts.ast,
                operation: "all",
                recursive: false,
                materialized: true,
              },
            ],
          }),
        ),
      "MATERIALIZED on a CTE is not supported by sqlite.",
    ],
  ];

  test.each(cases)("%s", (_name, _caps, compile, message) => {
    expect(compile).toThrow(message);
  });

  test("a dialect that takes everything compiles every case", () => {
    expect(() =>
      sql(
        limited({}),
        users.fullJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id)),
      ),
    ).not.toThrow();
  });

  test("bulk writes: joins and returning", () => {
    const set = [{ kind: "update" as const, field: "views", column: "views", value: literalNode(0) }];
    const joined = rebuild(posts.join(User, "u", ({ p, u }) => u.id.eq(p.authorId)).ast, { updates: set });
    expect(() =>
      createCompiler(limited({ updateJoin: false })).compile(joined, "updateAll", undefined),
    ).toThrow("UPDATE … FROM (a join in updateAll) is not supported by sqlite.");
    expect(() =>
      createCompiler(limited({ updateJoin: false })).compile(
        rebuild(joined, { updates: [] }),
        "deleteAll",
        undefined,
      ),
    ).toThrow("DELETE … USING (a join in deleteAll) is not supported by sqlite.");
    const returning = rebuild(posts.ast, { updates: set, select: selectOne(col("p", "id")) });
    expect(() =>
      createCompiler(limited({ returning: false })).compile(returning, "updateAll", undefined),
    ).toThrow("RETURNING is not supported by sqlite.");
  });

  test("row-level writes", () => {
    const tags = meta(Tag);
    const id = tags.fieldsByName.get("id") as FieldMeta;
    const name = tags.fieldsByName.get("name") as FieldMeta;
    const one = { kind: "values" as const, rows: 1 };
    expect(() =>
      createCompiler(limited({ returning: false })).compileInsert(
        tags,
        [name],
        { source: one, returning: [id], onConflict: undefined },
        undefined,
      ),
    ).toThrow("RETURNING is not supported by sqlite.");
    expect(() =>
      createCompiler(limited({ onConflict: false })).compileInsert(
        tags,
        [name],
        { source: one, returning: [], onConflict: "nothing" },
        undefined,
      ),
    ).toThrow("onConflict is not supported by sqlite.");
    expect(() =>
      createCompiler(limited({ conflictTarget: false })).compileInsert(
        tags,
        [name],
        { source: one, returning: [], onConflict: { target: [name], update: "all" } },
        undefined,
      ),
    ).toThrow("An onConflict target is not supported by sqlite.");
    expect(() =>
      createCompiler(limited({ insertDefaultValues: false })).compileInsert(
        tags,
        [],
        { source: one, returning: [], onConflict: undefined },
        undefined,
      ),
    ).toThrow("INSERT … DEFAULT VALUES is not supported by sqlite.");
  });
});

describe("dialect clause variants", () => {
  test("a dialect that ignores locks writes nothing for any clause lock() produces, whatever its lock modes", () => {
    const sqlite = limited({ lockModes: [] }, { ignoresLocks: true });
    for (const [mode, options] of [
      ["update", {}],
      ["share", { noWait: true }],
      ["keyShare", { skipLocked: true }],
    ] as const) {
      expect(
        sql(
          sqlite,
          from(User, "u")
            .lock(mode, options)
            .select(({ u }) => u.id),
        ),
      ).toBe('select "u"."id" as "c0" from "users" as "u"');
    }
    const ast = rebuild(from(User, "u").ast, { lock: { kind: "lock", clause: "FOR UPDATE OF everything" } });
    expect(() => sql(sqlite, ast)).toThrow(
      'query.lockClause: The lock clause "FOR UPDATE OF everything" is not one sqlite accepts as a string.',
    );
  });

  test("a lock fragment that is not written binds nothing either", () => {
    const sqlite = limited({ arrayParams: false }, { ignoresLocks: true, placeholder: "positional" });
    const ast = rebuild(
      from(User, "u")
        .where(({ u }) => u.age.gt(1))
        .select(({ u }) => u.id).ast,
      {
        lock: { kind: "lock", clause: frag`for update wait ${value(5)}` },
      },
    );
    const plan = createCompiler(sqlite).compile(ast, "all", undefined);
    expect(plan.sql).toBe('select "u"."id" as "c0" from "users" as "u" where "u"."age" > ?');
    expect(plan.slots.length).toBe(plan.sql.split("?").length - 1);
    expect(bindParams(plan.slots, ast.params)).toEqual([1]);
    // An unknown lock string is still refused.
    expect(() => sql(sqlite, rebuild(ast, { lock: { kind: "lock", clause: "FOR NOTHING" } }))).toThrow(
      'query.lockClause: The lock clause "FOR NOTHING" is not one sqlite accepts as a string.',
    );
  });

  test("a dialect that ignores locks writes none", () => {
    const sqlite = limited({}, { ignoresLocks: true });
    expect(
      sql(
        sqlite,
        from(User, "u")
          .lock("update")
          .select(({ u }) => u.id),
      ),
    ).toBe('select "u"."id" as "c0" from "users" as "u"');
    expect(
      sql(
        sqlite,
        from(User, "u")
          .lock(fragment`for update`)
          .select(({ u }) => u.id),
      ),
    ).toBe('select "u"."id" as "c0" from "users" as "u"');
  });

  test("a JSON path can be written one arrow per key", () => {
    const arrows = limited({}, { jsonPath: "arrows" });
    expect(sql(arrows, selecting(jsonPathNode(col("u", "settings"), [value("a"), value(0)], true)))).toBe(
      'select "u"."settings" -> $1 ->> $2 as "c0" from "users" as "u"',
    );
    expect(sql(arrows, selecting(jsonPathNode(col("u", "settings"), [value("a")], false)))).toBe(
      'select "u"."settings" -> $1 as "c0" from "users" as "u"',
    );
  });

  test("a dialect whose upsert takes no target", () => {
    const tags = meta(Tag);
    const name = tags.fieldsByName.get("name") as FieldMeta;
    const plan = createCompiler(limited({}, { conflictUpdateNeedsTarget: false })).compileInsert(
      tags,
      [name],
      {
        source: { kind: "values", rows: 1 },
        returning: [],
        onConflict: { target: undefined, update: "all" },
      },
      undefined,
    );
    expect(plan.sql).toBe(
      'insert into "tags" ("name") values ($1) on conflict do update set "name" = "excluded"."name"',
    );
  });

  test("identifiers are quoted with the dialect's quote character, doubled inside a name", () => {
    const backtick = limited({}, { quote: "`" });
    expect(sql(backtick, rebuild(bareQuery(tableOf(User, "a`b")), {}))).toContain("from `users` as `a``b`");
    expect(sql(postgresDialect, rebuild(bareQuery(tableOf(User, 'a"b')), {}))).toContain(
      'from "users" as "a""b"',
    );
  });
});

describe("refused nodes", () => {
  test.each([
    [
      "an unknown unary operator",
      () => where(unaryNode("twice" as never, col("u", "id"))),
      'Unknown unary operator "twice".',
    ],
    [
      "an unknown binary operator",
      () => where(binaryNode("approx" as never, col("u", "id"), value(1))),
      'Unknown operator "approx".',
    ],
    [
      "an unknown boolean operator",
      () => where(naryNode("xor" as never, [literalNode(true), literalNode(false)])),
      'Unknown boolean operator "xor".',
    ],
    [
      "a function not in the table",
      () => where(fnNode("pg_sleep", [value(1)])),
      'The function "pg_sleep" is not in the postgres function table.',
    ],
    [
      "an inherited property name as a function",
      () => where(fnNode("constructor", [])),
      'The function "constructor" is not in the postgres function table.',
    ],
    [
      "an aggregate not in the table",
      () => selecting(aggregateNode("median", [col("u", "age")], false, undefined, undefined)),
      'The aggregate "median" is not in the postgres aggregate table.',
    ],
    [
      "an identifier that does not match the pattern",
      () => where({ kind: "ident", name: 'x"; drop' }),
      "fragment.ident() holds a name that is not an identifier, so it was not written.",
    ],
    [
      "a window name that is not an identifier",
      () => selecting(aggregateNode("count", [col("u", "id")], false, undefined, "w x")),
      "A window name is not an identifier, so it was not written.",
    ],
    [
      "a fragment with the wrong number of strings",
      () => where({ kind: "fragment", strings: ["a", "b"], args: [] }),
      "A fragment must have exactly one more string than it has arguments.",
    ],
    [
      "a fragment with a string that is not one",
      () => where({ kind: "fragment", strings: [1 as never], args: [] }),
      "A fragment's strings must be strings.",
    ],
    ["an empty tuple", () => where(binaryNode("eq", tupleNode([]), tupleNode([]))), "A tuple has no items."],
    ["a CASE without branches", () => selecting(caseNode([], value(1))), "A CASE has no WHEN branch."],
    [
      "an empty JSON path",
      () => selecting(jsonPathNode(col("u", "settings"), [], false)),
      "A JSON path has no keys.",
    ],
    [
      "a literal that is not safe text",
      () => selecting({ kind: "literal", value: "x" as never }),
      "A literal holds something other than true, false, null or a finite number",
    ],
    [
      "an infinite literal",
      () => selecting({ kind: "literal", value: Number.POSITIVE_INFINITY }),
      "A literal holds something other than",
    ],
    [
      "a cast without a type",
      () => ({
        ...selecting(literalNode(1)),
        select: selectOne({ kind: "cast", expr: literalNode(1), type: undefined as never }),
      }),
      "A cast has no column type to cast to.",
    ],
    [
      "an unknown expression kind",
      () => selecting({ kind: "mystery" } as never),
      'Unknown expression node kind "mystery".',
    ],
    [
      "an unknown where combinator",
      () =>
        rebuild(from(User, "u").ast, {
          wheres: [
            { kind: "bool", op: "and", expr: literalNode(true) },
            { kind: "bool", op: "nor" as never, expr: literalNode(true) },
          ],
        }),
      'Unknown boolean operator "nor".',
    ],
  ] as const)("%s", (_name, ast, message) => {
    expect(() => sql(postgresDialect, ast())).toThrow(message);
  });

  test("a custom type's SQL is written only when it is a plain type name", () => {
    const good = defineType<string>({
      name: "money",
      db: { kind: "custom", sql: "numeric(10, 2)" },
      cast: (v) => ({ success: true, data: String(v) }),
    });
    expect(sql(postgresDialect, selecting(castNode(col("u", "age"), good)))).toBe(
      'select cast("u"."age" as numeric(10, 2)) as "c0" from "users" as "u"',
    );
    const bad = { ...good, db: { kind: "custom" as const, sql: "text); drop table users; --" } };
    expect(() => sql(postgresDialect, selecting(castNode(col("u", "age"), bad)))).toThrow(
      "A custom column type's sql is not a plain type name",
    );
    const unknownKind = { ...good, db: { kind: "varchar" as never } };
    expect(() => sql(postgresDialect, selecting(castNode(col("u", "age"), unknownKind)))).toThrow(
      'The column type kind "varchar" has no SQL name in postgres.',
    );
  });

  test("an array type is cast to its element type with []", () => {
    expect(sql(postgresDialect, selecting(paramNode([1], typeOf(t.array(t.integer())), false)))).toBe(
      'select cast($1 as integer[]) as "c0" from "users" as "u"',
    );
  });

  test("compile() takes a query", () => {
    expect(() =>
      createCompiler(postgresDialect).compile({ kind: "fragment" } as never, "all", undefined),
    ).toThrow("query.compileArgument: compile() takes a query.");
  });
});

describe("operator precedence", () => {
  test("a one-argument and/or is its argument; an empty one is a literal", () => {
    const one = naryNode("or", [binaryNode("eq", col("u", "id"), value(1))]);
    expect(precedenceOf(postgresDialect, one)).toBe(PRECEDENCE.comparison);
    expect(sql(postgresDialect, where(one))).toContain('where "u"."id" = $1');
    expect(precedenceOf(postgresDialect, naryNode("and", []))).toBe(PRECEDENCE.atom);
  });

  test("not() parenthesises anything but an atom", () => {
    expect(sql(postgresDialect, where(unaryNode("not", col("u", "id"))))).toContain('where not "u"."id"');
    expect(sql(postgresDialect, where(unaryNode("not", unaryNode("isNull", col("u", "id")))))).toContain(
      'where not ("u"."id" is null)',
    );
  });

  test("a negative literal binds like a unary minus", () => {
    expect(precedenceOf(postgresDialect, literalNode(-2))).toBe(PRECEDENCE.unary);
    expect(precedenceOf(postgresDialect, literalNode(-0))).toBe(PRECEDENCE.unary);
    expect(precedenceOf(postgresDialect, literalNode(2))).toBe(PRECEDENCE.atom);
  });

  test("in() binds like a comparison with an array, like LIKE with a subquery or an expanded list", () => {
    const list = binaryNode("in", col("u", "id"), listNode([1], undefined, false));
    expect(precedenceOf(postgresDialect, list)).toBe(PRECEDENCE.comparison);
    expect(precedenceOf(positional, list)).toBe(PRECEDENCE.like);
    expect(
      precedenceOf(
        postgresDialect,
        binaryNode("in", col("u", "id"), { kind: "subquery", query: from(User, "u").ast }),
      ),
    ).toBe(PRECEDENCE.like);
    expect(precedenceOf(postgresDialect, binaryNode("in", value(1), col("p", "tags")))).toBe(
      PRECEDENCE.comparison,
    );
    expect(precedenceOf(postgresDialect, binaryNode("has", col("p", "tags"), value(1)))).toBe(
      PRECEDENCE.comparison,
    );
  });

  test("unknown operators rank as atoms (and are refused when written)", () => {
    expect(precedenceOf(postgresDialect, unaryNode("twice" as never, col("u", "id")))).toBe(PRECEDENCE.atom);
    expect(precedenceOf(postgresDialect, binaryNode("approx" as never, col("u", "id"), col("u", "id")))).toBe(
      PRECEDENCE.atom,
    );
  });

  test("a selected name ranks as its expression, or as an atom when it is a reference", () => {
    expect(
      precedenceOf(postgresDialect, {
        kind: "selectedAs",
        name: "x",
        expr: binaryNode("add", value(1), value(2)),
      }),
    ).toBe(PRECEDENCE.additive);
    expect(precedenceOf(postgresDialect, { kind: "selectedAs", name: "x", expr: undefined })).toBe(
      PRECEDENCE.atom,
    );
  });

  test("a window spec with only a frame, and an order by inside an aggregate's window", () => {
    const spec = windowNode([], [orderNode(col("u", "id"), "desc", "first")], frag`rows unbounded preceding`);
    expect(
      sql(postgresDialect, selecting(aggregateNode("count", [col("u", "id")], true, undefined, spec))),
    ).toBe(
      'select count(distinct "u"."id") over (order by "u"."id" desc nulls first rows unbounded preceding) as "c0" from "users" as "u"',
    );
  });
});

describe("extension registry", () => {
  registerNodeEmitter("testGreatest", {
    precedence: PRECEDENCE.atom,
    emit: (node: { readonly args: readonly ExprNode[] }, api) =>
      `greatest(${node.args.map((arg) => api.expr(arg, PRECEDENCE.fragment)).join(", ")}, ${api.quote("x")}, (${api.query(from(Tag, "t").select(({ t: tag }) => tag.id).ast)}))`,
    sameShape: (a: { readonly args: readonly unknown[] }, b: { readonly args: readonly unknown[] }) =>
      a.args.length === b.args.length,
  });

  test("a registered node kind is written by its emitter", () => {
    const node = { kind: "testGreatest", args: [col("u", "id"), col("u", "age")] } as unknown as ExprNode;
    expect(sql(postgresDialect, selecting(node))).toBe(
      'select greatest("u"."id", "u"."age", "x", (select "t"."id" as "c0" from "tags" as "t")) as "c0" from "users" as "u"',
    );
    expect(precedenceOf(postgresDialect, node)).toBe(PRECEDENCE.atom);
  });

  test("a built-in or already registered kind cannot be registered", () => {
    const emitter = { precedence: 0, emit: () => "", sameShape: () => true };
    expect(() => registerNodeEmitter("binary", emitter)).toThrow(
      'The node kind "binary" already has an emitter.',
    );
    expect(() => registerNodeEmitter("testGreatest", emitter)).toThrow(
      'The node kind "testGreatest" already has an emitter.',
    );
  });
});

describe("the case tables", () => {
  test("every case has an expectation for every dialect, and Postgres refuses none", () => {
    for (const [area, cases] of ALL_CASES) {
      for (const sqlCase of cases) {
        for (const dialect of DIALECTS) {
          expect(sqlCase.expected[dialect.name], `${area}: ${sqlCase.name} on ${dialect.name}`).toBeDefined();
        }
        expect(sqlCase.expected.postgres, sqlCase.name).not.toHaveProperty("error");
      }
    }
  });

  test("run() binds named values", () => {
    const sqlCase = ALL_CASES.flatMap(([, cases]) => cases).find((c) => c.named !== undefined);
    expect(sqlCase).toBeDefined();
    if (sqlCase !== undefined) {
      const result = run(createCompiler(postgresDialect), sqlCase);
      expect("params" in result && result.params.length).toBeGreaterThan(0);
    }
  });

  test("withDialects refuses a table that names a case the area has not, and two cases of one name", () => {
    const [one] = ALL_CASES[0]?.[1] ?? [];
    if (one === undefined) throw new Error("no cases");
    expect(() => withDialects("select", [one], { mysql: { select: { nope: { error: "x" } } } })).toThrow(
      /names "nope", which the select matrix has not/,
    );
    expect(() => withDialects("select", [one, one], {})).toThrow(/two cases of one name/);
    expect(withDialects("other", [one], { mysql: {} })[0]?.expected).toEqual(one.expected);
  });
});
