import { Post, Tag, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { FieldMeta } from "../contracts/schema.js";
import { from } from "../index.js";
import { binaryNode } from "../query/ast.js";
import { meta } from "../schema/index.js";
import { bindParams } from "./bind.js";
import { PlanCache } from "./cache.js";
import { createCompiler } from "./compiler.js";
import { POSTGRES_CAPABILITIES, postgresDialect, type SqlDialect } from "./dialect.js";
import { ALL_CASES } from "./sql-cases.js";
import { col, frag, rebuild, selectOne, value } from "./sql-fixtures.js";

const expanding: SqlDialect = {
  ...postgresDialect,
  name: "mysql",
  placeholder: "positional",
  capabilities: { ...POSTGRES_CAPABILITIES, arrayParams: false },
};

const byAge = (age: number) =>
  from(User, "u")
    .where(({ u }) => u.age.gte(age))
    .select(({ u }) => u.id);

describe("L1: by identity", () => {
  test("the same AST compiles once; later calls return the same plan", () => {
    const compiler = createCompiler(postgresDialect);
    const ast = byAge(18).ast;
    const first = compiler.compile(ast, "all", undefined);
    expect(compiler.compile(ast, "all", undefined)).toBe(first);
    expect(compiler.stats()).toEqual({ hits: 1, misses: 1, collisions: 0, size: 1 });
  });

  test("one AST has a plan per operation and per database schema", () => {
    const compiler = createCompiler(postgresDialect);
    const ast = from(Post, "p").where(({ p }) => p.views.lt(1)).ast;
    const select = compiler.compile(ast, "all", undefined);
    const tenant = compiler.compile(ast, "all", "tenant_1");
    const remove = compiler.compile(ast, "deleteAll", undefined);
    expect(new Set([select, tenant, remove]).size).toBe(3);
    expect(tenant.sql).toContain('"tenant_1"."posts"');
    expect(compiler.compile(ast, "all", "tenant_1")).toBe(tenant);
    expect(compiler.compile(ast, "deleteAll", undefined)).toBe(remove);
    expect(compiler.stats()).toMatchObject({ hits: 2, misses: 3, collisions: 0 });
  });
});

describe("L2: by shape", () => {
  test("queries that differ only in values share one plan", () => {
    const compiler = createCompiler(postgresDialect);
    const a = byAge(18);
    const b = byAge(65);
    expect(a.ast).not.toBe(b.ast);
    const plan = compiler.compile(a.ast, "all", undefined);
    expect(compiler.compile(b.ast, "all", undefined)).toBe(plan);
    expect(bindParams(plan.slots, b.ast.params)).toEqual([65]);
    expect(compiler.stats()).toEqual({ hits: 1, misses: 1, collisions: 0, size: 1 });
  });

  test("an L2 hit is remembered for that AST at L1", () => {
    const compiler = createCompiler(postgresDialect);
    compiler.compile(byAge(1).ast, "all", undefined);
    const other = byAge(2).ast;
    compiler.compile(other, "all", undefined);
    compiler.compile(other, "all", undefined);
    expect(compiler.stats()).toMatchObject({ hits: 2, misses: 1 });
  });

  test("on Postgres, lists of any length share one plan", () => {
    const compiler = createCompiler(postgresDialect);
    const ids = (list: number[]) => from(User, "u").where(({ u }) => u.id.in(list)).ast;
    const plan = compiler.compile(ids([1]), "all", undefined);
    expect(compiler.compile(ids([1, 2, 3, 4, 5]), "all", undefined)).toBe(plan);
    expect(compiler.compile(ids([7]), "all", undefined)).toBe(plan);
  });

  test("where lists are expanded, each length has its own plan", () => {
    const compiler = createCompiler(expanding);
    const ids = (list: number[]) =>
      from(User, "u")
        .where(({ u }) => u.id.in(list))
        .select(({ u }) => u.id).ast;
    const one = compiler.compile(ids([1]), "all", undefined);
    const three = compiler.compile(ids([1, 2, 3]), "all", undefined);
    expect(three).not.toBe(one);
    expect(three.sql).toBe('select "u"."id" as "c0" from "users" as "u" where "u"."id" in (?, ?, ?)');
    expect(compiler.compile(ids([4, 5, 6]), "all", undefined)).toBe(three);
    expect(compiler.stats().collisions).toBe(0);
  });

  test("different schemas, types or redaction make different plans", () => {
    const compiler = createCompiler(postgresDialect);
    const base = from(User, "u").select(({ u }) => u.id).ast;
    const withParam = (type: unknown, redact: boolean) =>
      rebuild(base, {
        wheres: [
          {
            kind: "bool",
            op: "and",
            expr: binaryNode("eq", col("u", "id"), { kind: "param", value: 1, type: type as never, redact }),
          },
        ],
      });
    const idType = (meta(User).fieldsByName.get("id") as FieldMeta).type;
    const plain = compiler.compile(withParam(undefined, false), "all", undefined);
    const typed = compiler.compile(withParam(idType, false), "all", undefined);
    const hidden = compiler.compile(withParam(idType, true), "all", undefined);
    expect(new Set([plain, typed, hidden]).size).toBe(3);
    expect(hidden.slots[0]?.redact).toBe(true);
    expect(compiler.stats().collisions).toBe(0);
  });

  test("the least recently used shape is evicted when the cache is full", () => {
    const compiler = createCompiler(postgresDialect, { planCacheSize: 2 });
    const shapes = [
      () => from(User, "u").where(({ u }) => u.age.gt(1)).ast,
      () => from(User, "u").where(({ u }) => u.age.lt(1)).ast,
      () => from(User, "u").where(({ u }) => u.age.eq(1)).ast,
    ];
    const first = compiler.compile(shapes[0]?.() as never, "all", undefined);
    compiler.compile(shapes[1]?.() as never, "all", undefined);
    compiler.compile(shapes[0]?.() as never, "all", undefined); // shape 0 is now the newest
    compiler.compile(shapes[2]?.() as never, "all", undefined); // evicts shape 1
    expect(compiler.stats().size).toBe(2);
    expect(compiler.compile(shapes[0]?.() as never, "all", undefined)).toBe(first);
    const missesBefore = compiler.stats().misses;
    compiler.compile(shapes[1]?.() as never, "all", undefined);
    expect(compiler.stats().misses).toBe(missesBefore + 1);
  });

  test("clearCache drops every plan, the same AST's included, and keeps the counters", () => {
    const compiler = createCompiler(postgresDialect);
    const ast = byAge(1).ast;
    const first = compiler.compile(ast, "all", undefined);
    compiler.clearCache();
    expect(compiler.stats()).toEqual({ hits: 0, misses: 1, collisions: 0, size: 0 });
    const again = compiler.compile(ast, "all", undefined);
    expect(again).not.toBe(first);
    expect(compiler.stats()).toEqual({ hits: 0, misses: 2, collisions: 0, size: 1 });
    compiler.compile(byAge(2).ast, "all", undefined);
    expect(compiler.stats().hits).toBe(1);
  });

  test("planCacheSize must be a positive integer", () => {
    expect(() => createCompiler(postgresDialect, { planCacheSize: 0 })).toThrow(RangeError);
  });
});

describe("hash collisions", () => {
  test("a forced collision is caught by the structural check and never serves a wrong plan", () => {
    const compiler = createCompiler(postgresDialect, { keyOf: () => 42 });
    const ages = byAge(18);
    const emails = from(User, "u")
      .where(({ u }) => u.email.eq("a@b.c"))
      .select(({ u }) => u.id);
    const agesPlan = compiler.compile(ages.ast, "all", undefined);
    const emailsPlan = compiler.compile(emails.ast, "all", undefined);
    expect(emailsPlan).not.toBe(agesPlan);
    expect(emailsPlan.sql).toContain('"u"."email" = $1');
    expect(compiler.stats().collisions).toBe(1);
    // The entry now holds the emails plan; ages misses again (another collision), compiles correctly.
    expect(compiler.compile(byAge(30).ast, "all", undefined).sql).toBe(agesPlan.sql);
    expect(compiler.stats()).toMatchObject({ collisions: 2, misses: 3, hits: 0 });
    // Same shape as the stored entry: a real hit despite the constant hash.
    expect(compiler.compile(byAge(40).ast, "all", undefined).sql).toBe(agesPlan.sql);
    expect(compiler.stats()).toMatchObject({ collisions: 2, hits: 1 });
  });

  test("a forced collision between operations or schemas of one shape is caught too", () => {
    const compiler = createCompiler(postgresDialect, { keyOf: () => 7 });
    const ast = () => from(Post, "p").where(({ p }) => p.views.lt(1)).ast;
    const select = compiler.compile(ast(), "all", undefined);
    // The constant hash ignores the operation; only the stored operation tells them apart.
    const cache = new PlanCache({ capacity: 4, keyLists: false, keyOf: () => 7 });
    cache.set(ast(), "all", undefined, 1, [], select);
    expect(cache.get(ast(), "deleteAll", undefined, 1, [])).toBeUndefined();
    expect(cache.get(ast(), "all", "tenant_1", 1, [])).toBeUndefined();
    expect(cache.stats().collisions).toBe(2);
    expect(compiler.stats().collisions).toBe(0);
  });

  test("a forced collision between list lengths on an expanding dialect is caught", () => {
    const cache = new PlanCache({ capacity: 4, keyLists: true, keyOf: () => 3 });
    const ast = from(User, "u").where(({ u }) => u.id.in([1, 2])).ast;
    const plan = createCompiler(expanding).compile(ast, "all", undefined);
    cache.set(ast, "all", undefined, ast.shape, [2], plan);
    const other = from(User, "u").where(({ u }) => u.id.in([1, 2, 3])).ast;
    expect(cache.get(other, "all", undefined, other.shape, [3])).toBeUndefined();
    expect(cache.stats().collisions).toBe(1);
    const same = from(User, "u").where(({ u }) => u.id.in([5, 6])).ast;
    expect(cache.get(same, "all", undefined, same.shape, [2])).toBe(plan);
  });

  test("no collision when compiling every case of the matrices twice in one cache", () => {
    const compiler = createCompiler(postgresDialect);
    for (let round = 0; round < 2; round++) {
      for (const [, cases] of ALL_CASES) for (const sqlCase of cases) sqlCase.compile(compiler);
    }
    expect(compiler.stats().collisions).toBe(0);
  });
});

describe("row-level write plans", () => {
  const users = meta(User);
  const tags = meta(Tag);
  const email = users.fieldsByName.get("email") as FieldMeta;
  const name = users.fieldsByName.get("name") as FieldMeta;
  const id = users.fieldsByName.get("id") as FieldMeta;
  const tagName = tags.fieldsByName.get("name") as FieldMeta;

  test("inserting the same columns reuses one plan; other columns, rows or options do not", () => {
    const compiler = createCompiler(postgresDialect);
    const insert = (columns: FieldMeta[], rows = 1, schema?: string) =>
      compiler.compileInsert(
        users,
        columns,
        { source: { kind: "values", rows }, returning: [id], onConflict: undefined },
        schema,
      );
    const plan = insert([email, name]);
    expect(insert([email, name])).toBe(plan);
    expect(insert([name, email])).not.toBe(plan);
    expect(insert([email, name], 2)).not.toBe(plan);
    expect(insert([email, name], 1, "tenant_1")).not.toBe(plan);
    expect(compiler.stats()).toMatchObject({ hits: 1, misses: 4, collisions: 0 });
  });

  test("updates and deletes are cached by their field lists", () => {
    const compiler = createCompiler(postgresDialect);
    const update = compiler.compileUpdate(users, [name], [id], [], undefined);
    expect(compiler.compileUpdate(users, [name], [id], [], undefined)).toBe(update);
    expect(compiler.compileUpdate(users, [email], [id], [], undefined)).not.toBe(update);
    const remove = compiler.compileDelete(users, [id], [], undefined);
    expect(compiler.compileDelete(users, [id], [], undefined)).toBe(remove);
    expect(compiler.compileDelete(users, [id], [email], undefined)).not.toBe(remove);
  });

  test("cells, query sources and conflict options are part of the key", () => {
    const compiler = createCompiler(postgresDialect);
    const cells = (second: "value" | "default") =>
      compiler.compileInsert(
        users,
        [email, name],
        {
          source: {
            kind: "cells",
            rows: [[{ kind: "value" }, second === "value" ? { kind: "value" } : { kind: "default" }]],
          },
          returning: [],
          onConflict: undefined,
        },
        undefined,
      );
    expect(cells("value")).toBe(cells("value"));
    expect(cells("default")).not.toBe(cells("value"));

    const placeholder = (who: string) =>
      compiler.compileInsert(
        users,
        [email],
        {
          source: { kind: "cells", rows: [[{ kind: "placeholder", name: who }]] },
          returning: [],
          onConflict: undefined,
        },
        undefined,
      );
    expect(placeholder("a")).toBe(placeholder("a"));
    expect(placeholder("a").slots).not.toEqual(placeholder("b").slots);

    const expression = (v: number) =>
      compiler.compileInsert(
        users,
        [email],
        {
          source: { kind: "cells", rows: [[{ kind: "expr", expr: value(v) }]] },
          returning: [],
          onConflict: undefined,
        },
        undefined,
      );
    expect(expression(1)).toBe(expression(2));

    const fromQuery = (age: number) =>
      compiler.compileInsert(
        tags,
        [tagName],
        { source: { kind: "query", query: byAge(age).ast }, returning: [], onConflict: undefined },
        undefined,
      );
    expect(fromQuery(1)).toBe(fromQuery(2));

    const upsert = (onConflict: unknown) =>
      compiler.compileInsert(
        users,
        [email, name],
        { source: { kind: "values", rows: 1 }, returning: [], onConflict: onConflict as never },
        undefined,
      );
    const variants = [
      upsert(undefined),
      upsert("nothing"),
      upsert({ target: [email], update: "all" }),
      upsert({ target: [email], update: [name] }),
      upsert({ target: [email], update: { except: [email] } }),
      upsert({ target: { constraint: "users_email_key" }, update: "all" }),
      upsert({ target: frag`(email)`, update: "all" }),
    ];
    expect(new Set(variants).size).toBe(variants.length);
    expect(upsert({ target: frag`(email)`, update: "all" })).toBe(variants[6]);
    expect(compiler.stats().collisions).toBe(0);
  });

  test("a write key collision with different AST parts is caught", () => {
    const cache = new PlanCache({ capacity: 4, keyLists: false, keyOf: undefined });
    const plan = createCompiler(postgresDialect).compileDelete(users, [id], [], undefined);
    cache.setWrite("k", [value(1)], plan);
    expect(cache.getWrite("k", [col("u", "id")])).toBeUndefined();
    expect(cache.getWrite("k", [value(2)])).toBe(plan);
    expect(cache.getWrite("k", [])).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, collisions: 2 });
  });

  test("unusual descriptions still make keys; the emitter refuses them", () => {
    const compiler = createCompiler(postgresDialect);
    const odd = (options: unknown) => () =>
      compiler.compileInsert(users, [email], options as never, undefined);
    expect(
      odd({ source: { kind: "cells", rows: [[{ kind: "nope" }]] }, returning: [], onConflict: undefined }),
    ).toThrow('Unknown insert cell kind "nope".');
    expect(odd({ source: { kind: "cells", rows: "x" }, returning: [], onConflict: undefined })).toThrow(
      "An insert of cells needs at least one row.",
    );
    expect(odd({ source: { kind: "values", rows: 1 }, returning: [], onConflict: 5 })).toThrow(
      'onConflict is "nothing" or { target, update }.',
    );
    expect(
      odd({
        source: { kind: "values", rows: 1 },
        returning: [],
        onConflict: { target: { other: 1 }, update: "all" },
      }),
    ).toThrow("onConflict's target is a list of fields, { constraint: name } or a fragment.");
    expect(
      odd({ source: { kind: "values", rows: 1 }, returning: [], onConflict: { target: [email], update: 3 } }),
    ).toThrow('onConflict\'s update is "all", a list of fields or { except }.');
  });
});

describe("explain and fragment plans", () => {
  test("an explain plan is cached per query plan and options", () => {
    const compiler = createCompiler(postgresDialect);
    const ast = byAge(1).ast;
    const a = compiler.compileExplain(ast, "all", undefined, { analyze: true });
    expect(compiler.compileExplain(byAge(2).ast, "all", undefined, { analyze: true })).toBe(a);
    expect(compiler.compileExplain(ast, "all", undefined, { analyze: true, format: "json" })).not.toBe(a);
  });

  test("a fragment statement is cached by identity and by shape", () => {
    const compiler = createCompiler(postgresDialect);
    const statement = (v: number) => frag`select ${value(v)} as n`;
    const node = statement(1);
    const plan = compiler.compileFragment(node);
    expect(compiler.compileFragment(node)).toBe(plan);
    expect(compiler.compileFragment(statement(2))).toBe(plan);
    expect(compiler.compileFragment(frag`select 2 as n`)).not.toBe(plan);
    expect(compiler.stats()).toMatchObject({ hits: 2, misses: 2, collisions: 0 });
  });

  test("a fragment and a query never share an entry", () => {
    const compiler = createCompiler(postgresDialect, { keyOf: () => 1 });
    const ast = rebuild(from(User, "u").ast, { select: selectOne(col("u", "id")) });
    compiler.compile(ast, "all", undefined);
    compiler.compileFragment(frag`select 1`);
    expect(compiler.stats()).toMatchObject({ misses: 2 });
  });
});

describe("list lengths where lists are expanded", () => {
  const posts = meta(Post);
  const authorId = posts.fieldsByName.get("authorId") as FieldMeta;
  const title = posts.fieldsByName.get("title") as FieldMeta;
  const ids = (list: number[]) =>
    from(User, "u")
      .where(({ u }) => u.id.in(list))
      .select(({ u }) => [u.id, u.email]).ast;

  /** A warm compiler must give what a cold one gives, for every length. */
  function sameAsCold(
    compile: (
      compiler: ReturnType<typeof createCompiler>,
      list: number[],
    ) => { sql: string; slots: readonly unknown[] },
  ) {
    const warm = createCompiler(expanding);
    for (const list of [[1, 2], [1, 2, 3], [4, 5], [6]]) {
      const cold = compile(createCompiler(expanding), list);
      const hot = compile(warm, list);
      expect(hot.sql).toBe(cold.sql);
      expect(hot.slots).toEqual(cold.slots);
    }
    expect(warm.stats().collisions).toBe(0);
    return warm;
  }

  test("an insert from a query keys on the query's list lengths", () => {
    const warm = sameAsCold((c, list) =>
      c.compileInsert(
        posts,
        [authorId, title],
        { source: { kind: "query", query: ids(list) }, returning: [], onConflict: undefined },
        undefined,
      ),
    );
    // [1, 2] and [4, 5] share a plan.
    expect(warm.stats().hits).toBe(1);
    const plan = createCompiler(expanding).compileInsert(
      posts,
      [authorId, title],
      { source: { kind: "query", query: ids([1, 2, 3]) }, returning: [], onConflict: undefined },
      undefined,
    );
    expect(plan.sql).toContain('"u"."id" in (?, ?, ?)');
    expect(bindParams(plan.slots, ids([1, 2, 3]).params)).toEqual([1, 2, 3]);
  });

  test("an expression cell keys on its list lengths", () => {
    sameAsCold((c, list) =>
      c.compileInsert(
        posts,
        [authorId, title],
        {
          source: {
            kind: "cells",
            rows: [
              [
                {
                  kind: "expr",
                  expr: {
                    kind: "subquery",
                    query: rebuild(ids(list), { select: selectOne(col("u", "id")), limit: value(1) }),
                  },
                },
                { kind: "value" },
              ],
            ],
          },
          returning: [],
          onConflict: undefined,
        },
        undefined,
      ),
    );
  });

  test("a fragment conflict target keys on its list lengths", () => {
    const tags = meta(Tag);
    const name = tags.fieldsByName.get("name") as FieldMeta;
    sameAsCold((c, list) =>
      c.compileInsert(
        tags,
        [name],
        {
          source: { kind: "values", rows: 1 },
          returning: [],
          onConflict: {
            target: frag`(name) where id in (${{ kind: "subquery", query: rebuild(ids(list), { select: selectOne(col("u", "id")) }) }})`,
            update: "all",
          },
        },
        undefined,
      ),
    );
  });

  test("a fragment statement keys on the lengths of the lists inside it", () => {
    sameAsCold((c, list) =>
      c.compileFragment(frag`select exists (${{ kind: "subquery", query: ids(list) }}) as found`),
    );
  });

  test("explain and read plans key on list lengths", () => {
    sameAsCold((c, list) => c.compile(ids(list), "all", undefined));
    sameAsCold((c, list) => c.compileExplain(ids(list), "all", undefined, {}));
  });
});
