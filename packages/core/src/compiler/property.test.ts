import { Post, Tag, User } from "@egon-orm/test-support";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { ExprNode, QueryAst } from "../contracts/query.js";
import type { FieldMeta } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { caseWhen, coalesce, count, fragment, from, param, t, val } from "../index.js";
import {
  aggregateNode,
  binaryNode,
  fnNode,
  literalNode,
  naryNode,
  orderNode,
  STAR,
  selectedAsNode,
  unaryNode,
  windowNode,
} from "../query/ast.js";
import { meta } from "../schema/index.js";
import { bindParams } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import {
  bareQuery,
  col,
  frag,
  rebuild,
  selectObject,
  selectOne,
  tableSource,
  typeOf,
  value,
} from "./sql-fixtures.js";

/** Every value the compiler would send, flattened (lists hold several). */
function flat(params: readonly unknown[]): unknown[] {
  return params.flatMap((p) => (Array.isArray(p) ? p : [p]));
}

// ---------------------------------------------------------------------------
// Values never become SQL text
// ---------------------------------------------------------------------------

/** One query with a caller's string in every value position the query layer has. */
function everyValuePosition(v: readonly string[]): { ast: QueryAst; named: Record<string, unknown> } {
  const s = (i: number) => v[i] as string;
  const q = from(User, "u")
    .leftJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id).and(p.title.neq(s(0))))
    .where(({ u }) => u.email.eq(s(1)))
    .where(({ u }) => u.email.in([s(2), s(3)]))
    .where(({ u }) => u.name.like(s(4)).or(u.name.ilike(s(5))))
    .where(({ u }) => u.email.between(s(6), s(7)))
    .where(({ u }) => u.settings.pathText(s(8)).eq(s(9)))
    .where(({ u }) => fragment`length(${u.email}) > length(${val(s(10))})`.as<boolean>())
    .where(({ u }) => u.role.eq(param("role", t.enum(["admin", "member"]))))
    .groupBy(({ u }) => u.id)
    .having(({ u }) => coalesce(u.name, s(11)).neq(s(12)))
    .select(({ u }) => ({
      id: u.id,
      label: val(s(13)),
      kind: caseWhen(u.age.lt(18), s(14)).else(s(15)),
      joined: u.email.concat(s(16)),
    }))
    .limit(10);
  return { ast: q.ast, named: { role: s(17) } };
}

const marked = (s: string, i: number) => `⟦${i}:${s}⟧`;

// Thousands of cold compiles take seconds, more under coverage on CI: these tests get
// their own timeouts instead of fewer runs.
const LONG = 120_000;
const SHORT = 60_000;

describe("injection: a value never reaches the SQL text", () => {
  test(
    "arbitrary strings in every value position are bound, never written (10,000 runs)",
    () => {
      fc.assert(
        fc.property(fc.array(fc.string({ unit: "binary" }), { minLength: 18, maxLength: 18 }), (strings) => {
          const values = strings.map(marked);
          const { ast, named } = everyValuePosition(values);
          const plan = createCompiler(postgresDialect).compile(ast, "all", undefined);
          expect(plan.sql).not.toContain("⟦");
          const bound = flat(bindParams(plan.slots, ast.params, named));
          for (const v of values) expect(bound).toContain(v);
        }),
        { numRuns: 10_000 },
      );
    },
    LONG,
  );

  test(
    "values in limit, offset, VALUES cells, fragment sources and row-level writes are bound",
    () => {
      const users = meta(User);
      const email = users.fieldsByName.get("email") as FieldMeta;
      const name = users.fieldsByName.get("name") as FieldMeta;
      fc.assert(
        fc.property(fc.array(fc.string({ unit: "binary" }), { minLength: 8, maxLength: 8 }), (strings) => {
          const v = strings.map(marked);
          const ast = rebuild(
            bareQuery({ kind: "values", columns: ["a"], rows: [[value(v[0])], [value(v[1])]], alias: "x" }),
            {
              joins: [
                {
                  kind: "join",
                  type: "cross",
                  source: {
                    kind: "fragmentSource",
                    fragment: frag`unnest(${value([v[2]])})`,
                    columns: ["b"],
                    alias: "y",
                  },
                  on: undefined,
                },
              ],
              select: selectOne(col("x", "a")),
              limit: value(v[3]),
              offset: value(v[4]),
            },
          );
          const compiler = createCompiler(postgresDialect);
          const plan = compiler.compile(ast, "all", undefined);
          expect(plan.sql).not.toContain("⟦");
          const bound = flat(bindParams(plan.slots, ast.params));
          for (const value of v.slice(0, 5)) expect(bound).toContain(value);

          const insert = compiler.compileInsert(
            users,
            [email, name],
            {
              source: {
                kind: "cells",
                rows: [
                  [
                    { kind: "value" },
                    {
                      kind: "expr",
                      expr: fnNode("lower", [{ kind: "param", value: v[5], type: undefined, redact: false }]),
                    },
                  ],
                ],
              },
              returning: [],
              onConflict: undefined,
            },
            undefined,
          );
          expect(insert.sql).not.toContain("⟦");
          expect(bindParams(insert.slots, [v[6], v[5]])).toEqual([v[6], v[5]]);
        }),
        { numRuns: 1_000 },
      );
    },
    SHORT,
  );
});

// ---------------------------------------------------------------------------
// Names from the AST reach the SQL only quoted
// ---------------------------------------------------------------------------

/** The SQL with every quoted identifier taken out. */
function unquoted(sql: string): string {
  return sql.replace(/"(?:[^"]|"")*"/g, "");
}

describe("identifiers: a name from the AST is always quoted", () => {
  test(
    "arbitrary names in every identifier position appear only inside quotes",
    () => {
      fc.assert(
        fc.property(fc.array(fc.string({ unit: "binary" }), { minLength: 12, maxLength: 12 }), (strings) => {
          const n = strings.map((s, i) => `«${i}:${s}»`);
          const name = (i: number) => n[i] as string;
          const inner = rebuild(bareQuery(tableSource(name(0), name(1), undefined, name(2))), {
            select: selectObject({ [name(3)]: col(name(1), name(4)) }),
          });
          const ast = rebuild(
            bareQuery({ kind: "cteSource", name: name(5), meta: undefined, alias: name(6) }),
            {
              ctes: [
                {
                  kind: "cte",
                  name: name(5),
                  query: inner,
                  operation: "all",
                  recursive: false,
                  materialized: undefined,
                },
              ],
              joins: [
                {
                  kind: "join",
                  type: "inner",
                  source: { kind: "values", columns: [name(7)], rows: [[literalNode(1)]], alias: name(8) },
                  on: binaryNode("eq", col(name(6), name(3)), col(name(8), name(7))),
                },
              ],
              select: selectObject({
                a: selectedAsNode(name(9), col(name(6), name(3))),
                b: aggregateNode(
                  "count",
                  [STAR],
                  false,
                  undefined,
                  windowNode([col(name(8), name(7))], [], undefined),
                ),
              }),
              orderBys: [orderNode(selectedAsNode(name(9), undefined), "asc", undefined)],
            },
          );
          const plan = createCompiler(postgresDialect).compile(ast, "all", name(10));
          expect(unquoted(plan.sql)).not.toMatch(/[«»]/);
          for (const id of n.slice(0, 10)) expect(plan.sql).toContain(`"${id.replaceAll('"', '""')}"`);
        }),
        { numRuns: 2_000 },
      );
    },
    SHORT,
  );

  test(
    "names in a row-level write and a bulk update are quoted",
    () => {
      fc.assert(
        fc.property(fc.string({ unit: "binary" }), fc.string({ unit: "binary" }), (a, b) => {
          const column = `«${a}»`;
          const schema = `«${b}»`;
          const ast = rebuild(from(Post, "p").ast, {
            updates: [{ kind: "update", field: "views", column, value: literalNode(0) }],
          });
          const plan = createCompiler(postgresDialect).compile(ast, "updateAll", schema);
          expect(unquoted(plan.sql)).not.toMatch(/[«»]/);
          const tags = meta(Tag);
          const write = createCompiler(postgresDialect).compileDelete(
            tags,
            [tags.fieldsByName.get("id") as FieldMeta],
            [],
            schema,
          );
          expect(unquoted(write.sql)).not.toMatch(/[«»]/);
        }),
        { numRuns: 500 },
      );
    },
    SHORT,
  );

  test(
    "names that are looked up in a table are refused when they are not in it",
    () => {
      const users = from(User, "u");
      const where = (expr: ExprNode) =>
        rebuild(users.ast, {
          wheres: [{ kind: "bool", op: "and", expr }],
          select: selectOne(col("u", "id")),
        });
      const positions: readonly ((s: string) => QueryAst)[] = [
        (s) => where(binaryNode(s as never, col("u", "id"), value(1))),
        (s) => where(unaryNode(s as never, col("u", "id"))),
        (s) => where(naryNode(s as never, [literalNode(true), literalNode(true)])),
        (s) => where(fnNode(s, [])),
        (s) =>
          rebuild(users.ast, { select: selectOne(aggregateNode(s, [STAR], false, undefined, undefined)) }),
        (s) => rebuild(users.ast, { lock: { kind: "lock", clause: s } }),
        (s) =>
          rebuild(users.ast, {
            joins: [
              {
                kind: "join",
                type: s as never,
                source: tableSource("t", "t", undefined),
                on: literalNode(true),
              },
            ],
          }),
        (s) => rebuild(users.ast, { orderBys: [orderNode(col("u", "id"), s as never, undefined)] }),
        (s) => rebuild(users.ast, { orderBys: [orderNode(col("u", "id"), "asc", s as never)] }),
        (s) =>
          rebuild(users.ast, {
            combinations: [{ kind: "combination", op: s as never, all: false, query: users.ast }],
          }),
        (s) => where({ kind: "ident", name: `${s} x` }),
        (s) =>
          rebuild(users.ast, {
            select: selectOne(aggregateNode("count", [STAR], false, undefined, `${s} x`)),
          }),
      ];
      const known = new Set([
        ...Object.keys(postgresDialect.operators),
        ...Object.keys(postgresDialect.functions),
        ...Object.keys(postgresDialect.aggregates),
        ...Object.keys(postgresDialect.locks),
        "in",
        "notIn",
        "has",
        "not",
        "neg",
        "isNull",
        "isNotNull",
        "and",
        "or",
        "inner",
        "left",
        "right",
        "full",
        "cross",
        "innerLateral",
        "leftLateral",
        "asc",
        "desc",
        "first",
        "last",
        "union",
        "intersect",
        "except",
      ]);
      fc.assert(
        fc.property(
          fc.string({ unit: "binary" }).filter((s) => !known.has(s)),
          fc.integer({ min: 0, max: positions.length - 1 }),
          (s, i) => {
            const build = positions[i] as (s: string) => QueryAst;
            let ast: QueryAst;
            try {
              ast = build(s);
            } catch {
              return; // The AST helpers refused it already.
            }
            expect(() => createCompiler(postgresDialect).compile(ast, "all", undefined)).toThrow(QueryError);
          },
        ),
        { numRuns: 2_000 },
      );
    },
    SHORT,
  );
});

// ---------------------------------------------------------------------------
// One plan, any values
// ---------------------------------------------------------------------------

interface Values {
  readonly a: number;
  readonly b: string;
  readonly c: readonly number[];
  readonly d: number;
  readonly e: string;
  readonly f: number;
}

/** Queries with values in many clauses, written in non-canonical order on purpose. */
const TEMPLATES: readonly ((v: Values) => QueryAst)[] = [
  // A set operation ordered by a selected expression that holds a value: the order item
  // is found by structure, so another value must give the same SQL.
  (v) => {
    const branch = (n: number) =>
      from(User, "u")
        .where(({ u }) => u.email.neq(v.b))
        .select(({ u }) => ({ x: u.age.add(n), y: u.email })).ast;
    return rebuild(branch(v.a), {
      combinations: [{ kind: "combination", op: "union", all: true, query: branch(v.d) }],
      orderBys: [
        orderNode(binaryNode("add", col("u", "age"), value(v.f, typeOf(t.integer()))), "desc", undefined),
      ],
      limit: value(v.d, typeOf(t.integer())),
    });
  },
  (v) =>
    from(User, "u")
      .limit(v.d)
      .orderBy(({ u }) => u.age.add(v.f).desc())
      .select(({ u }) => ({ id: u.id, tag: val(v.e) }))
      .where(({ u }) => u.age.gte(v.a))
      .leftJoin(Post, "p", ({ u, p }) => p.authorId.eq(u.id).and(p.title.neq(v.b)))
      .where(({ u }) => u.id.in(v.c))
      .offset(v.f).ast,
  (v) =>
    from(Post, "p")
      .select(({ p }) => ({ author: p.authorId, label: val(v.b), n: count(p.id).add(v.d) }))
      .groupBy(({ p }) => p.authorId)
      .having(({ p }) => count(p.id).gt(v.a))
      .where(({ p }) => p.title.like(v.e).or(p.authorId.in(v.c))).ast,
  (v) =>
    rebuild(
      from(User, "u")
        .where(({ u }) => u.email.neq(v.e))
        .select(({ u }) => ({ id: u.id })).ast,
      {
        ctes: [
          {
            kind: "cte",
            name: "recent",
            query: from(Post, "p")
              .where(({ p }) => p.views.gt(v.a))
              .select(({ p }) => ({ id: p.authorId })).ast,
            operation: "all",
            recursive: false,
            materialized: undefined,
          },
        ],
        combinations: [
          {
            kind: "combination",
            op: "union",
            all: true,
            query: from(Post, "p")
              .where(({ p }) => p.title.eq(v.b))
              .select(({ p }) => ({ id: p.authorId })).ast,
          },
        ],
        limit: value(v.d, typeOf(t.integer())),
        wheres: [
          {
            kind: "bool",
            op: "and",
            expr: binaryNode("has", fnNode("arrayAppend", [col("u", "tags"), value(v.b)]), value(v.e)),
          },
        ],
      },
    ),
  (v) =>
    from(User, "u")
      .where(({ u }) =>
        u.id.in(
          from(Post, "p")
            .where(({ p }) => p.views.between(v.a, v.d))
            .select(({ p }) => p.authorId),
        ),
      )
      .where(({ u }) => u.settings.pathText(v.b).eq(v.e))
      .select(({ u }) => caseWhen(u.age.lt(v.f), v.b).else(v.e)).ast,
];

const valuesArb: fc.Arbitrary<Values> = fc.record({
  a: fc.integer(),
  b: fc.string(),
  // Non-empty: in([]) is the literal false, another shape.
  c: fc.array(fc.integer(), { minLength: 1, maxLength: 6 }),
  d: fc.nat(),
  e: fc.string(),
  f: fc.nat(),
});

describe("parameter binding is independent of the AST the plan was compiled from", () => {
  test(
    "a plan compiled from values A, bound with values B, equals a cold compile of B",
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: TEMPLATES.length - 1 }), valuesArb, valuesArb, (i, a, b) => {
          const template = TEMPLATES[i] as (v: Values) => QueryAst;
          const shared = createCompiler(postgresDialect);
          const astA = template(a);
          const astB = template(b);
          const planA = shared.compile(astA, "all", undefined);
          const planB = shared.compile(astB, "all", undefined);
          expect(planB).toBe(planA);
          const cold = createCompiler(postgresDialect).compile(astB, "all", undefined);
          expect(planA.sql).toBe(cold.sql);
          expect(bindParams(planA.slots, astB.params)).toEqual(bindParams(cold.slots, astB.params));
          expect(shared.stats().collisions).toBe(0);
        }),
        { numRuns: 1_000 },
      );
    },
    SHORT,
  );
});
