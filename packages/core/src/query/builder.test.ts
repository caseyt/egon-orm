// Unit tests for the query builder: the AST each clause builds, that a built query's
// params, list lengths and shape agree with walking its AST, immutability (on deep-frozen
// queries), the binding cache, joins through every kind of association, preload
// declarations, and every QueryError.
import { Comment, Membership, Org, Post, Profile, Tag, User } from "@egon-orm/test-support";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { QueryAst } from "../contracts/query.js";
import { QueryError } from "../errors.js";
import { hasMany, manyToMany, meta, Schema, t } from "../schema/index.js";
import { defineType } from "../types/index.js";
import { collectParams, listNode, type NamedParamNode, shapeOf } from "./ast.js";
import { bindingInfo, bindingOf, registerBinding } from "./bindings.js";
import { AS_SOURCE, from, hasNamedBinding, type Query, render, type SourceParts } from "./builder.js";
import { AS_SUBQUERY, Col, isExpr } from "./expr.js";
import { show } from "./expr-fixtures.js";
import { count, exists, fragment, param, sum, val } from "./functions.js";

type AnyQuery = Query<unknown, unknown, never, string>;

/** Freezes an object and everything it holds, so that any later write throws. */
function deepFreeze<V>(value: V, seen = new Set<unknown>()): V {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  // Schema metadata, classes and field types are shared with the rest of the package; the
  // query's own nodes and arrays are what must never change.
  if (bindingInfo(value as object) !== undefined) return value;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "meta" || key === "type") continue;
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/** A built query's caches agree with walking its AST. */
function expectConsistent(query: {
  readonly ast: QueryAst;
  readonly named: readonly NamedParamNode[];
}): void {
  const params: unknown[] = [];
  const lists: number[] = [];
  const named: NamedParamNode[] = [];
  collectParams(query.ast, params, lists, named);
  expect(query.ast.params).toEqual(params);
  expect(query.ast.listLengths).toEqual(lists);
  expect(query.ast.shape).toBe(shapeOf(query.ast));
  expect(query.named).toEqual(named);
}

function frozen<Q extends { readonly ast: QueryAst }>(query: Q): Q {
  deepFreeze(query.ast);
  return Object.freeze(query);
}

function bools(ast: QueryAst): string[] {
  return ast.wheres.map((node) => `${node.op} ${show(node.expr)}`);
}

describe("from", () => {
  test("starts a query with a table source under the alias", () => {
    const q = from(User, "u");
    expect(q.ast.from).toEqual({
      kind: "table",
      source: "users",
      meta: meta(User),
      schema: undefined,
      alias: "u",
    });
    expect(q.ast.params).toEqual([]);
    expect(q.toString()).toBe("from users as u");
    expectConsistent(q);
  });

  test("refuses a query, a missing alias, a reserved alias and anything that is not a source", () => {
    expect(() => from(from(User, "u") as never, "x")).toThrow(
      /from\(\) does not take a query.*subquery\(q\)/,
    );
    expect(() => from(User, undefined as never)).toThrow(/from\(\) needs an alias/);
    expect(() => from(User, "")).toThrow(/from\(\) needs an alias/);
    expect(() => from(User, "$u")).toThrow(/"\$u".*reserved/);
    expect(() => from({} as never, "x")).toThrow(/from\(\) takes a schema class/);
    expect(() => from("users" as never, "x")).toThrow(QueryError);
  });

  test("refuses an embedded schema", () => {
    const Address = meta(User).embeds[0]?.schema();
    expect(Address).toBeDefined();
    expect(() => from(Address as never, "a")).toThrow(/embedded schema/);
  });

  test("starting a query over the same schema and alias gives the same (immutable) query", () => {
    expect(from(User, "u")).toBe(from(User, "u"));
    expect(from(User, "v")).not.toBe(from(User, "u"));
    expect(from(Post, "u")).not.toBe(from(User, "u"));
  });

  test("a query is made only by from", () => {
    const Ctor = from(User, "u").constructor as new (...args: unknown[]) => unknown;
    expect(() => new Ctor()).toThrow(/made with from\(\)/);
  });

  test("takes a source wrapper through its AS_SOURCE method", () => {
    const binding = { n: new Col("r", meta(Post).fieldsByName.get("views") as never) };
    registerBinding(binding, { alias: "r", meta: undefined });
    const wrapper = {
      [AS_SOURCE](alias: string): SourceParts {
        return {
          node: { kind: "cteSource", name: "recent", meta: undefined, alias },
          binding,
          meta: undefined,
          params: [7],
          lists: [],
          named: [],
        };
      },
    };
    const q = from(wrapper as never, "r") as unknown as AnyQuery;
    expect(q.ast.from).toEqual({ kind: "cteSource", name: "recent", meta: undefined, alias: "r" });
    expect(q.ast.params).toEqual([7]);
    const narrowed = q.where((({ r }: { r: { n: Col<number> } }) => r.n.gt(3)) as never);
    expect(narrowed.ast.params).toEqual([7, 3]);
    expect(() => q.select((({ r }: { r: object }) => r) as never)).toThrow(/whole binding "r".*no schema/);
    expect(() => q.preload("x" as never)).toThrow(/root binding "r" has none/);
    expect(() => q.reverseOrder()).toThrow(/no primary key/);
  });
});

describe("bindings", () => {
  test("are built once per schema and alias", () => {
    const seen: unknown[] = [];
    from(User, "u").where(({ u }) => {
      seen.push(u);
      return u.age.gte(1);
    });
    from(User, "u").where(({ u }) => {
      seen.push(u);
      return u.age.gte(2);
    });
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe(bindingOf(meta(User), User, "u"));
    expect(bindingOf(meta(User), User, "v")).not.toBe(seen[0]);
  });

  test("hold one column per persisted field, then $schema and $alias, and are frozen", () => {
    const binding = bindingOf(meta(User), User, "u") as Record<string, unknown>;
    expect(Object.keys(binding)).toEqual([...meta(User).persisted.map((f) => f.name), "$schema", "$alias"]);
    expect(binding.password).toBeUndefined();
    expect(binding.$schema).toBe(User);
    expect(binding.$alias).toBe("u");
    expect(Object.isFrozen(binding)).toBe(true);
    const email = binding.email as Col<string>;
    expect(email).toBeInstanceOf(Col);
    expect(email.node).toEqual({ kind: "column", binding: "u", field: "email", column: "email" });
  });

  test("the bindings object is shared by the callbacks of a query and of the queries built from it", () => {
    const args: unknown[] = [];
    const q = from(User, "u").where((b) => {
      args.push(b);
      return b.u.age.gte(1);
    });
    q.orderBy((b) => {
      args.push(b);
      return b.u.id;
    }).limit(1);
    expect(args[0]).toBe(args[1]);
  });

  test("a self-join gets two bindings of one schema", () => {
    const q = from(User, "a").join(User, "b", ({ a, b }) => {
      expect(a).not.toBe(b);
      return a.email.eq(b.email);
    });
    expect(show(q.ast.joins[0]?.on)).toBe("(eq a.email b.email)");
  });
});

describe("where and orWhere", () => {
  test("several where calls are ANDed, orWhere is ORed against everything before it", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(18))
      .where(({ u }) => u.role.eq("member"))
      .orWhere(({ u }) => u.role.eq("admin"));
    expect(bools(q.ast)).toEqual([
      "and (gte u.age $18:integer)",
      'and (eq u.role $"member":enum)',
      'or (eq u.role $"admin":enum)',
    ]);
    expect(q.ast.params).toEqual([18, "member", "admin"]);
    expect(q.toString()).toBe("from users as u where ((u.age >= ?) and (u.role = ?)) or (u.role = ?)");
    expectConsistent(q);
  });

  test("the object form compares the root's fields: a value is =, null is IS NULL, an array is IN", () => {
    const q = from(User, "u").where({ role: "admin", name: null, id: [1, 2, 3] });
    expect(bools(q.ast)).toEqual([
      'and (and (eq u.role $"admin":enum) (isNull u.name) (in u.id $[1,2,3]:bigint(number)))',
    ]);
    expect(q.ast.listLengths).toEqual([3]);
    expectConsistent(q);
    const one = from(User, "u").where({ email: "a@example.com" });
    expect(bools(one.ast)).toEqual(['and (eq u.email $"a@example.com":string)']);
    expect(show(from(User, "u").orWhere({ age: 3 }).ast.wheres[0]?.expr)).toBe("(eq u.age $3:integer)");
  });

  test("the object form binds a redacted field's value redacted", () => {
    const q = from(User, "u").where({ passwordHash: "x" });
    expect(show(q.ast.wheres[0]?.expr)).toBe('(eq u.password_hash $"x":string!)');
  });

  test("the object form refuses undefined, unknown and virtual fields, and non-objects", () => {
    expect(() => from(User, "u").where({ role: undefined } as never)).toThrow(
      /where\(\{ role: undefined \}\) on the root binding "u" \(User\).*matches every row.*if \(value !== undefined\)/,
    );
    expect(() => from(User, "u").where({ nope: 1 } as never)).toThrow(
      /where\(\{ nope \}\) names a field that the root binding "u" \(User\) does not have.*email/,
    );
    expect(() => from(User, "u").where({ password: "x" } as never)).toThrow(/where\(\{ password \}\)/);
    expect(() => from(User, "u").where({ $schema: 1 } as never)).toThrow(/where\(\{ \$schema \}\)/);
    expect(() => from(User, "u").where([] as never)).toThrow(/where\(\) takes a callback or an object/);
    expect(() => from(User, "u").where(new Date() as never)).toThrow(
      /where\(\) takes a callback or an object/,
    );
    expect(() => from(User, "u").where(null as never)).toThrow(/where\(\) takes a callback or an object/);
    expect(() => from(User, "u").where({ id: [1, null] } as never)).toThrow(
      /where\(\{ id \}\) on the root binding "u" \(User\): in\(\)/,
    );
  });

  test("a callback must return a condition", () => {
    expect(() => from(User, "u").where(() => true as never)).toThrow(
      "query.conditionExpected: where() needs its callback to return a condition; it returned a boolean. Return a condition from the callback, such as ({ u }) => u.age.gte(18). See https://egon-orm.github.io/egon-orm/reference/errors/query#query-conditionexpected",
    );
    expect(() => from(User, "u").where(({ u }) => u.age as never)).toThrow(
      /where\(\) needs a condition, and its callback returned the integer expression u\.age/,
    );
    expect(() => from(User, "u").where(({ u }) => u.age.add(1) as never)).toThrow(
      /returned the integer expression\./,
    );
    expect(() => from(User, "u").where((() => [1]) as never)).toThrow(
      "query.conditionExpected: where() needs its callback to return a condition; it returned an array.",
    );
    expect(() => from(User, "u").where((() => null) as never)).toThrow(/returned null/);
    expect(() => from(User, "u").where((({ u }: { u: object }) => u) as never)).toThrow(
      /returned a whole binding/,
    );
    expect(() => from(User, "u").where((({ u }: { u: { id: Col<number> } }) => u.id.asc()) as never)).toThrow(
      /returned an order item/,
    );
    expect(() => from(User, "u").where((() => ({})) as never)).toThrow(/returned an object/);
  });

  test("a fragment is accepted as a condition", () => {
    const q = from(User, "u").where(({ u }) => fragment`${u.email} ~ ${"^a"}`.as<boolean>());
    expect(q.ast.params).toEqual(["^a"]);
    expectConsistent(q);
  });

  test("an error thrown inside a callback names the clause", () => {
    expect(() => from(User, "u").where(({ u }) => u.age.eq(null as never))).toThrow(
      /^[a-z]+(?:\.\w+)?: where\(\): eq\(\) was given null/,
    );
    const error = (() => {
      try {
        from(User, "u").where(({ u }) => u.age.eq(null as never));
      } catch (caught) {
        return caught as QueryError;
      }
      return undefined;
    })();
    expect(error?.cause).toBeInstanceOf(QueryError);
  });

  test("an error that is not a QueryError passes through unchanged", () => {
    const boom = new TypeError("boom");
    expect(() =>
      from(User, "u").where(() => {
        throw boom;
      }),
    ).toThrow(boom);
  });
});

describe("joins", () => {
  test("each kind of join builds its node, and the callback sees the new binding", () => {
    const q = from(User, "u")
      .join(Post, "p", ({ u, p }) => p.authorId.eq(u.id))
      .leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
      .rightJoin(Comment, "c", ({ p, c }) => c.postId.eq(p.id))
      .fullJoin(Tag, "t", ({ t: tag }) => tag.name.eq("ts"))
      .crossJoin(Org, "o");
    expect(q.ast.joins.map((j) => `${j.type} ${show(j.source)} ${show(j.on)}`)).toEqual([
      "inner posts p (eq p.author_id u.id)",
      "left profiles pr (eq pr.user_id u.id)",
      "right comments c (eq c.post_id p.id)",
      'full tags t (eq t.name $"ts":string)',
      "cross orgs o _",
    ]);
    expect(q.ast.params).toEqual(["ts"]);
    expect(q.toString()).toBe(
      "from users as u inner join posts as p on p.author_id = u.id left join profiles as pr on pr.user_id = u.id right join comments as c on c.post_id = p.id full join tags as t on t.name = ? cross join orgs as o",
    );
    expectConsistent(q);
  });

  test("an alias used twice throws, naming the alias and the schema", () => {
    expect(() => from(User, "u").join(Post, "u" as never, ({ u }) => u.id.eq(1))).toThrow(
      /join\(\) was given the alias "u", which this query already uses for User/,
    );
    expect(() => from(User, "u").joinAssoc("u", "posts", "u" as never)).toThrow(
      /joinAssoc\(\) was given the alias "u"/,
    );
  });

  test("a join needs a callback returning a condition", () => {
    expect(() => from(User, "u").join(Post, "p", undefined as never)).toThrow(/join\(\) takes a callback/);
    expect(() => from(User, "u").leftJoin(Post, "p", ({ p }) => p.title as never)).toThrow(
      /leftJoin\(\) needs a condition, and its callback returned the string expression p\.title/,
    );
  });
});

describe("joinAssoc", () => {
  const on = (q: AnyQuery): string[] => q.ast.joins.map((j) => `${j.type} ${show(j.source)} ${show(j.on)}`);

  test("hasMany and hasOne join on the target's foreign key", () => {
    const q = from(User, "u").joinAssoc("u", "posts", "p").leftJoinAssoc("u", "profile", "pr");
    expect(on(q as never)).toEqual([
      "inner posts p (eq p.author_id u.id)",
      "left profiles pr (eq pr.user_id u.id)",
    ]);
    expectConsistent(q);
  });

  test("belongsTo joins on the referenced key", () => {
    const q = from(Post, "p").joinAssoc("p", "author", "a");
    expect(on(q as never)).toEqual(["inner users a (eq a.id p.author_id)"]);
  });

  test("is the same as the hand-written join", () => {
    const assoc = from(User, "u").joinAssoc("u", "posts", "p");
    const manual = from(User, "u").join(Post, "p", ({ u, p }) => p.authorId.eq(u.id));
    expect(assoc.ast).toEqual(manual.ast);
  });

  test("an extra condition is ANDed into the ON", () => {
    const q = from(Post, "p").leftJoinAssoc("p", "comments", "c", ({ c }) => c.body.isNotNull());
    expect(on(q as never)).toEqual(["left comments c (and (eq c.post_id p.id) (isNotNull c.body))"]);
  });

  test("manyToMany through a table joins the table under an internal alias, then the target", () => {
    const q = from(Post, "p").joinAssoc("p", "tags", "tg");
    expect(on(q as never)).toEqual([
      "inner posts_tags $tg_join (eq $tg_join.post_id p.id)",
      "inner tags tg (eq tg.id $tg_join.tag_id)",
    ]);
    expect(q.hasBinding("$tg_join")).toBe(false);
    expect(q.hasBinding("tg")).toBe(true);
    expectConsistent(q);
  });

  test("manyToMany through a join schema uses the schema's table and fields", () => {
    const q = from(User, "u").leftJoinAssoc("u", "orgs", "o");
    expect(on(q as never)).toEqual([
      "left memberships $o_join (eq $o_join.user_id u.id)",
      "left orgs o (eq o.id $o_join.org_id)",
    ]);
    expect(q.ast.joins[0]?.source).toMatchObject({
      kind: "table",
      source: "memberships",
      meta: meta(Membership),
    });
  });

  test("a has-through association follows the chain", () => {
    const q = from(User, "u").joinAssoc("u", "comments", "c");
    expect(on(q as never)).toEqual([
      "inner posts $c_0_posts (eq $c_0_posts.author_id u.id)",
      "inner comments c (eq c.post_id $c_0_posts.id)",
    ]);
    expect(q.hasBinding("c")).toBe(true);
    expect(q.hasBinding("$c_0_posts")).toBe(false);
  });

  test("the association's where and joinWhere are ANDed into the ON as bound values", () => {
    class Author extends Schema("authors", { id: t.integer().primaryKey() }) {
      static live = hasManyWhere();
      static labels = manyToManyWhere();
    }
    const q = from(Author, "a")
      .joinAssoc("a", "live" as never, "p")
      .joinAssoc("a", "labels" as never, "l");
    expect(on(q as never)).toEqual([
      'inner articles p (and (eq p.author_id a.id) (eq p.state $"live":string) (isNull p.removed_at))',
      'inner authors_labels $l_join (and (eq $l_join.author_id a.id) (eq $l_join.kind $"main"))',
      'inner labels l (and (eq l.id $l_join.label_id) (in l.color $["red","blue"]:string))',
    ]);
    expect(q.ast.params).toEqual(["live", "main", ["red", "blue"]]);
    expectConsistent(q);
  });

  test("a joinWhere value takes its column's type from the join schema; an array value on an array column is equality", () => {
    class AuthorLabel extends Schema("authors_labels", {
      authorId: t.integer().primaryKey(),
      labelId: t.integer().primaryKey(),
      kind: t.string(),
    }) {}
    class Shelf extends Schema("shelves", {
      id: t.integer().primaryKey(),
      authorId: t.integer(),
      tags: t.array(t.string()),
    }) {}
    class Author extends Schema("authors", { id: t.integer().primaryKey() }) {
      static labels = manyToMany(() => Label, {
        joinThrough: () => AuthorLabel,
        joinKeys: { owner: "authorId", target: "labelId" },
        joinWhere: { kind: "main" },
      });
      static shelves = hasMany(() => Shelf, { foreignKey: "authorId", where: { tags: ["a", "b"] } });
    }
    const q = from(Author, "a")
      .joinAssoc("a", "labels" as never, "l")
      .joinAssoc("a", "shelves" as never, "s");
    const conditions = on(q as never);
    expect(conditions[0]).toContain('(eq $l_join.kind $"main":string)');
    expect(conditions[2]).toMatch(/\(eq s\.tags \$\["a","b"\]/);
  });

  test("refuses an unknown binding, association or alias", () => {
    expect(() => from(User, "u").joinAssoc("x" as never, "posts" as never, "p")).toThrow(
      /joinAssoc\("x", …\) starts from a binding this query does not have\. Its bindings are: u/,
    );
    expect(() => from(User, "u").joinAssoc("u", "nope" as never, "p")).toThrow(
      /joinAssoc\("u", "nope", …\): User has no association "nope"\. Its associations are: profile, posts/,
    );
    expect(() => from(User, "u").joinAssoc(1 as never, "posts" as never, "p")).toThrow(
      /takes the alias of the binding/,
    );
    expect(() => from(User, "u").joinAssoc("u", 1 as never, "p")).toThrow(/takes the name of an association/);
    expect(() => from(Tag, "t").joinAssoc("t", "posts", "$p" as never)).toThrow(/reserved/);
  });
});

// Schemas with association filters, for the joinAssoc test above.
class Article extends Schema("articles", {
  id: t.integer().primaryKey(),
  authorId: t.integer(),
  state: t.string(),
  removedAt: t.timestamp().nullable(),
}) {}
class Label extends Schema("labels", { id: t.integer().primaryKey(), color: t.string() }) {}

function hasManyWhere() {
  return hasMany(() => Article, { foreignKey: "authorId", where: { state: "live", removedAt: null } });
}
function manyToManyWhere() {
  return manyToMany(() => Label, {
    joinThrough: "authors_labels",
    joinKeys: { owner: "author_id", target: "label_id" },
    joinWhere: { kind: "main" },
    where: { color: ["red", "blue"] },
  });
}

describe("select", () => {
  test("records the output tree for every shape", () => {
    const q = from(User, "u").joinAssoc("u", "posts", "p");
    expect(q.select(({ u }) => u.email).ast.select).toEqual({
      kind: "select",
      shape: {
        kind: "expr",
        expr: { kind: "column", binding: "u", field: "email", column: "email" },
        type: meta(User).fieldsByName.get("email")?.type,
      },
      constants: [],
    });
    expect(q.select(({ u }) => u).ast.select?.shape).toEqual({
      kind: "binding",
      binding: "u",
      meta: meta(User),
    });
    const obj = q.select(({ u, p }) => ({ user: u, title: p.title, kind: "user", n: count(p.id) }));
    expect(obj.ast.select?.shape).toMatchObject({
      kind: "object",
      keys: ["user", "title", "kind", "n"],
      values: [{ kind: "binding" }, { kind: "expr" }, { kind: "constant", index: 0 }, { kind: "expr" }],
    });
    expect(obj.ast.select?.constants).toEqual(["user"]);
    const tuple = q.select(({ u, p }) => [u.id, [p.title, 1]] as const);
    expect(tuple.ast.select?.shape).toMatchObject({
      kind: "tuple",
      items: [{ kind: "expr" }, { kind: "tuple", items: [{ kind: "expr" }, { kind: "constant", index: 0 }] }],
    });
    expect(tuple.toString()).toContain("select [u.id, [p.title, <value>]]");
    expectConsistent(obj);
  });

  test("collects the parameters of selected expressions in canonical order", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(30))
      .select(({ u }) => ({ a: u.age.add(1), b: [u.age.mul(2), { c: val("x") }] }));
    expect(q.ast.params).toEqual([30, 1, 2, "x"]);
    const later = from(User, "u")
      .select(({ u }) => ({ a: u.age.add(1) }))
      .where(({ u }) => u.age.gte(30));
    expect(later.ast.params).toEqual([30, 1]);
    expectConsistent(q);
    expectConsistent(later);
  });

  test("plain values are kept as constants, never as parameters", () => {
    const when = new Date(0);
    const q = from(User, "u").select(({ u }) => ({ id: u.id, when, nothing: null, big: 1n }));
    expect(q.ast.params).toEqual([]);
    expect(q.ast.select?.constants).toEqual([when, null, 1n]);
    expect(q.ast.shape).toBe(
      from(User, "u").select(({ u }) => ({ id: u.id, when: 5, nothing: 6, big: 7 })).ast.shape,
    );
  });

  test("refuses a second select, an order item, a query, a function and a symbol", () => {
    const q = from(User, "u").select(({ u }) => u.id);
    expect(() => q.select(({ u }) => u.email)).toThrow(
      /already has a select.*selectMerge\(\).*exclude\("select"\)/,
    );
    expect(() => from(User, "u").select(({ u }) => ({ a: { b: u.id.desc() } }))).toThrow(
      /select\(\) was given an order item \(asc\(\) or desc\(\)\) at "a\.b"/,
    );
    expect(() => from(User, "u").select(() => [from(Post, "p")])).toThrow(
      /select\(\) was given a query at "0"/,
    );
    expect(() => from(User, "u").select(() => ({ f: () => 1 }))).toThrow(/a function at "f"/);
    expect(() => from(User, "u").select(() => Symbol("s"))).toThrow(/a symbol, which is not a value/);
  });

  test("selectMerge adds keys and replaces existing ones in place", () => {
    const q = from(Post, "p")
      .select(({ p }) => ({ id: p.id, title: p.title, tag: "x" }))
      .selectMerge(({ p }) => ({ title: p.views.add(1), extra: "y", n: p.id.add(2) }));
    expect(q.ast.select?.shape).toMatchObject({ kind: "object", keys: ["id", "title", "tag", "extra", "n"] });
    expect(q.ast.select?.constants).toEqual(["x", "y"]);
    expect(q.ast.select?.shape).toMatchObject({
      values: [
        { kind: "expr" },
        { kind: "expr" },
        { kind: "constant", index: 0 },
        { kind: "constant", index: 1 },
        { kind: "expr" },
      ],
    });
    expect(q.ast.params).toEqual([1, 2]);
    expectConsistent(q);
    const nested = from(Post, "p")
      .select(({ p }) => ({ id: p.id }))
      .selectMerge(() => ({ a: { b: "c" }, d: ["e"] }));
    expect(nested.ast.select?.constants).toEqual(["c", "e"]);
    const noConstants = from(Post, "p")
      .select(() => ({ k: "z" }))
      .selectMerge(({ p }) => ({ id: p.id }));
    expect(noConstants.ast.select?.constants).toEqual(["z"]);
  });

  test("selectMerge needs an object select and an object to merge", () => {
    expect(() => from(Post, "p").selectMerge(({ p }) => ({ id: p.id }))).toThrow(
      /selectMerge\(\) adds keys to an object select, and this query has no select/,
    );
    expect(() =>
      from(Post, "p")
        .select(({ p }) => p.id)
        .selectMerge(({ p }) => ({ id: p.id })),
    ).toThrow(/this query selects one expression/);
    expect(() =>
      from(Post, "p")
        .select(({ p }) => p)
        .selectMerge(({ p }) => ({ id: p.id })),
    ).toThrow(/selects the whole binding "p"/);
    expect(() =>
      from(Post, "p")
        .select(({ p }) => [p.id])
        .selectMerge(({ p }) => ({ id: p.id })),
    ).toThrow(/selects an array/);
    expect(() =>
      from(Post, "p")
        .select(() => 1)
        .selectMerge(({ p }) => ({ id: p.id })),
    ).toThrow(/selects a plain value/);
    expect(() =>
      from(Post, "p")
        .select(({ p }) => ({ id: p.id }))
        .selectMerge(({ p }) => [p.id] as never),
    ).toThrow(
      "query.selectMergeResult: selectMerge() needs its callback to return an object of keys to add; it returned an array. Return an object of keys to add, as in selectMerge(({ p }) => ({ title: p.title })). See https://egon-orm.github.io/egon-orm/reference/errors/query#query-selectmergeresult",
    );
  });
});

describe("distinct, groupBy, having, orderBy", () => {
  test("distinct and distinct on", () => {
    expect(from(User, "u").distinct().ast.distinct).toEqual({ kind: "distinct", on: [] });
    const on = from(User, "u").distinct(({ u }) => [u.email, u.age.add(1)]);
    expect(on.ast.distinct?.on.map(show)).toEqual(["u.email", "(add u.age $1:integer)"]);
    expect(on.toString()).toBe("from users as u distinct on (u.email, u.age + ?)");
    expect(
      from(User, "u")
        .distinct(({ u }) => u.email)
        .ast.distinct?.on.map(show),
    ).toEqual(["u.email"]);
    expectConsistent(on);
    expect(() => on.distinct()).toThrow(/already has a distinct/);
    expect(() => from(User, "u").distinct((() => [1]) as never)).toThrow(
      /distinct\(\) needs its callback to return an expression.*in its array/,
    );
  });

  test("groupBy appends, having needs a groupBy", () => {
    const q = from(Post, "p")
      .groupBy(({ p }) => p.authorId)
      .groupBy(({ p }) => [p.published, p.views.add(1)])
      .having(({ p }) => count(p.id).gt(3))
      .having(({ p }) => sum(p.views).gt(10));
    expect(q.ast.groupBys.map(show)).toEqual(["p.author_id", "p.published", "(add p.views $1:integer)"]);
    expect(q.ast.havings.map((h) => show(h.expr))).toEqual([
      "(gt count(p.id) $3:bigint(number))",
      "(gt sum(p.views) $10:bigint(number))",
    ]);
    expect(q.ast.params).toEqual([1, 3, 10]);
    expect(q.toString()).toBe(
      "from posts as p group by p.author_id, p.published, p.views + ? having (count(p.id) > ?) and (sum(p.views) > ?)",
    );
    expectConsistent(q);
    expect(() => from(Post, "p").having(({ p }) => count(p.id).gt(3))).toThrow(
      /having\(\) filters groups.*no groupBy\(\)/,
    );
    expect(() =>
      from(Post, "p")
        .groupBy(({ p }) => p.id)
        .having({ id: 1 } as never),
    ).toThrow(/having\(\) takes a callback/);
    expect(() => from(Post, "p").groupBy((() => "x") as never)).toThrow(
      /groupBy\(\) needs its callback to return an expression.*a string/,
    );
  });

  test("orderBy appends; a bare expression is ascending", () => {
    const q = from(User, "u")
      .orderBy(({ u }) => [u.createdAt.desc().nullsLast(), u.id])
      .orderBy(({ u }) => u.name.asc().nullsFirst());
    expect(q.ast.orderBys.map(show)).toEqual([
      "(desc u.created_at nulls last)",
      "(asc u.id)",
      "(asc u.name nulls first)",
    ]);
    expect(q.toString()).toBe(
      "from users as u order by u.created_at desc nulls last, u.id, u.name nulls first",
    );
    expectConsistent(q);
    expect(() => from(User, "u").orderBy((() => 1) as never)).toThrow(
      /orderBy\(\) needs its callback to return an expression, an order item/,
    );
    expect(() => from(User, "u").orderBy((() => [1]) as never)).toThrow(/in its array/);
  });

  test("reverseOrder flips directions and nulls", () => {
    const q = from(User, "u")
      .orderBy(({ u }) => [u.createdAt.desc().nullsLast(), u.id, u.name.asc().nullsFirst(), u.age.add(5)])
      .reverseOrder();
    expect(q.ast.orderBys.map(show)).toEqual([
      "(asc u.created_at nulls first)",
      "(desc u.id)",
      "(desc u.name nulls last)",
      "(desc (add u.age $5:integer))",
    ]);
    expect(q.ast.params).toEqual([5]);
    expectConsistent(q);
  });

  test("reverseOrder with no order orders by the primary key, descending", () => {
    const q = from(User, "u").reverseOrder();
    expect(q.ast.orderBys.map(show)).toEqual(["(desc u.id)"]);
    expectConsistent(q);
    const composite = from(Membership, "m").reverseOrder();
    expect(composite.ast.orderBys.map(show)).toEqual(["(desc m.org_id)", "(desc m.user_id)"]);
    class Keyless extends Schema("keyless", { name: t.string() }, { primaryKey: false }) {}
    expect(() => from(Keyless, "k").reverseOrder()).toThrow(/reverseOrder\(\).*root "k" has no primary key/);
  });
});

describe("limit, offset, lock, schema", () => {
  test("limit and offset are bound integer parameters", () => {
    const q = from(User, "u").limit(10).offset(20);
    expect(show(q.ast.limit)).toBe("$10:integer");
    expect(show(q.ast.offset)).toBe("$20:integer");
    expect(q.ast.params).toEqual([10, 20]);
    expect(q.toString()).toBe("from users as u limit ? offset ?");
    expect(q.ast.shape).toBe(from(User, "u").limit(50).offset(0).ast.shape);
    expectConsistent(q);
  });

  test("a later limit replaces an earlier one, keeping parameters in canonical order", () => {
    const q = from(User, "u")
      .limit(10)
      .offset(5)
      .where(({ u }) => u.age.gte(1))
      .limit(3);
    expect(q.ast.params).toEqual([1, 3, 5]);
    expectConsistent(q);
  });

  test("limit takes a named parameter", () => {
    const q = from(User, "u").limit(param("pageSize", t.integer()));
    expect(show(q.ast.limit)).toBe(":pageSize:integer");
    expect(q.named.map((n) => n.name)).toEqual(["pageSize"]);
    expect(q.toString()).toBe("from users as u limit :pageSize");
    expectConsistent(q);
  });

  test("limit and offset refuse a negative, fractional or non-number value", () => {
    expect(() => from(User, "u").limit(-1)).toThrow(/limit\(\) takes a non-negative whole number.*given -1/);
    expect(() => from(User, "u").offset(1.5)).toThrow(
      /offset\(\) takes a non-negative whole number.*given 1\.5/,
    );
    expect(() => from(User, "u").limit("10" as never)).toThrow(/given a string/);
    expect(() => from(User, "u").limit(Number.NaN)).toThrow(/given NaN/);
  });

  test("replacing a limit that holds a named parameter is refused", () => {
    const q = from(User, "u").limit(param("n", t.integer()));
    expect(() => q.limit(5)).toThrow(
      /limit\(\) replacing the earlier limit would remove the named parameter "n"/,
    );
    expect(q.limit(param("n", t.integer())).named.map((n) => n.name)).toEqual(["n"]);
    const twice = from(User, "u")
      .where(({ u }) => u.age.gte(param("n", t.integer())))
      .limit(param("n", t.integer()));
    expect(twice.limit(1).named.map((n) => n.name)).toEqual(["n"]);
  });

  test("lock modes and options", () => {
    const clause = (q: AnyQuery) => q.ast.lock?.clause;
    expect(clause(from(Post, "p").lock("update") as never)).toBe("FOR UPDATE");
    expect(clause(from(Post, "p").lock("share", { noWait: true }) as never)).toBe("FOR SHARE NOWAIT");
    expect(clause(from(Post, "p").lock("noKeyUpdate", { skipLocked: true }) as never)).toBe(
      "FOR NO KEY UPDATE SKIP LOCKED",
    );
    expect(clause(from(Post, "p").lock("keyShare", {}) as never)).toBe("FOR KEY SHARE");
    expect(clause(from(Post, "p").lock("update", { skipLocked: false, noWait: false }) as never)).toBe(
      "FOR UPDATE",
    );
    expect(from(Post, "p").lock("update", { skipLocked: true }).toString()).toBe(
      "from posts as p for update skip locked",
    );
    const replaced = from(Post, "p").lock("update").lock("share");
    expect(replaced.ast.lock?.clause).toBe("FOR SHARE");
    expectConsistent(replaced);
  });

  test("lock takes a fragment, whose values are bound", () => {
    const q = from(Post, "p").lock(fragment`FOR UPDATE OF ${fragment.ident("p")} ${val(1)}`);
    expect(typeof q.ast.lock?.clause).toBe("object");
    expect(q.ast.params).toEqual([1]);
    expect(q.toString()).toBe("from posts as p lock fragment`FOR UPDATE OF p ?`");
    expectConsistent(q);
  });

  test("lock refuses unknown modes, options, both options, SQL strings and non-fragments", () => {
    expect(() => from(Post, "p").lock("FOR UPDATE" as never)).toThrow(/lock\(\) takes "update", "share"/);
    expect(() => from(Post, "p").lock("toString" as never)).toThrow(/lock\(\) takes "update"/);
    expect(() => from(Post, "p").lock("update", { skipLocked: true, noWait: true })).toThrow(/not both/);
    expect(() => from(Post, "p").lock("update", { wait: 5 } as never)).toThrow(
      /lock\(\) has no option "wait"/,
    );
    expect(() => from(Post, "p").lock("update", true as never)).toThrow(/options as an object/);
    expect(() => from(Post, "p").lock(val(1) as never)).toThrow(/a mode .* or a fragment/);
  });

  test("schema sets the query's database schema", () => {
    const q = from(User, "u").schema("tenant_1");
    expect(q.ast.schema).toBe("tenant_1");
    expect(q.ast.shape).not.toBe(from(User, "u").schema("tenant_2").ast.shape);
    expect(q.toString()).toBe("from users as u schema tenant_1");
    expectConsistent(q);
    expect(() => from(User, "u").schema("")).toThrow(/schema\(\) takes the name/);
  });
});

describe("exclude and pipe", () => {
  test("exclude removes each clause and its parameters", () => {
    const full = from(Post, "p")
      .where(({ p }) => p.views.gt(1))
      .distinct(({ p }) => p.title.concat("x"))
      .groupBy(({ p }) => [p.id, p.views.add(2)])
      .having(({ p }) => count(p.id).gt(3))
      .select(({ p }) => ({ id: p.id, v: p.views.add(4) }))
      .orderBy(({ p }) => p.views.add(5))
      .limit(6)
      .offset(7)
      .lock(fragment`FOR UPDATE ${val(8)}`);
    expect(full.ast.params).toEqual([1, 4, "x", 2, 3, 5, 6, 7, 8]);
    const cases = [
      ["where", [4, "x", 2, 3, 5, 6, 7, 8]],
      ["select", [1, "x", 2, 3, 5, 6, 7, 8]],
      ["distinct", [1, 4, 2, 3, 5, 6, 7, 8]],
      ["having", [1, 4, "x", 2, 5, 6, 7, 8]],
      ["orderBy", [1, 4, "x", 2, 3, 6, 7, 8]],
      ["limit", [1, 4, "x", 2, 3, 5, 7, 8]],
      ["offset", [1, 4, "x", 2, 3, 5, 6, 8]],
      ["lock", [1, 4, "x", 2, 3, 5, 6, 7]],
    ] as const;
    // A groupBy goes after its having (tested below).
    expect(full.exclude("having").exclude("groupBy").ast.params).toEqual([1, 4, "x", 5, 6, 7, 8]);
    for (const [clause, params] of cases) {
      const q = full.exclude(clause);
      expect(q.ast.params, clause).toEqual(params);
      expectConsistent(q);
    }
    expect(full.exclude("orderBy").ast.orderBys).toEqual([]);
    expect(full.exclude("select").ast.select).toBeUndefined();
    expect(full.exclude("lock").ast.lock).toBeUndefined();
  });

  test("exclude gives the plain query back", () => {
    const q = from(User, "u").where(({ u }) => u.age.gte(1));
    expect(q.exclude("where").ast).toEqual(from(User, "u").ast);
    expect(q.preload("posts").exclude("preload").ast).toEqual(q.ast);
  });

  test("exclude refuses an unknown clause, and to drop a named parameter", () => {
    expect(() => from(User, "u").exclude("join" as never)).toThrow(
      'query.excludeUnknown: exclude() was given "join", which is not a clause it removes. exclude() takes where, select, distinct, groupBy, having, orderBy, limit, offset, lock, preload, set, windows, withCte or setOperations.',
    );
    expect(() => from(User, "u").exclude(1 as never)).toThrow(
      "query.excludeUnknown: exclude() was given a number, which is not a clause it removes.",
    );
    const q = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    expect(() => q.exclude("where")).toThrow(/exclude\("where"\) would remove the named parameter "minAge"/);
    const pre = from(User, "u").preload("posts", (x) =>
      x.where(({ posts }) => posts.views.gt(param("v", t.integer()))),
    );
    expect(() => pre.exclude("preload")).toThrow(/would remove the named parameter "v"/);
  });

  test("pipe applies a function", () => {
    const q = from(User, "u");
    expect(q.pipe((x) => x.limit(1)).ast.limit).toBeDefined();
    expect(q.pipe(() => 5)).toBe(5);
    expect(() => q.pipe(5 as never)).toThrow(/pipe\(\) takes a function/);
  });
});

describe("named parameters across clauses", () => {
  test("are collected from every clause, in canonical order", () => {
    const q = from(User, "u")
      .limit(param("pageSize", t.integer()))
      .where(({ u }) => u.age.gte(param("minAge", t.integer())))
      .joinAssoc("u", "posts", "p", ({ p }) => p.views.gte(param("minViews", t.integer())));
    expect(q.named.map((n) => n.name)).toEqual(["minViews", "minAge", "pageSize"]);
    expect(q.namedParams()).toEqual(["pageSize", "minAge", "minViews"]);
    expectConsistent(q);
  });

  test("one name with two types is refused, naming both types", () => {
    const q = from(User, "u").where(({ u }) => u.age.gte(param("n", t.integer())));
    expect(() => q.where(({ u }) => u.email.eq(param("n" as never, t.string())))).toThrow(
      /named parameter "n" is used with two types, integer and string/,
    );
    expect(() => q.orderBy(({ u }) => u.email.concat(param("n" as never, t.string())))).toThrow(/two types/);
    expect(() => q.limit(param("n" as never, t.string()) as never)).toThrow(/two types/);
    expect(q.where(({ u }) => u.age.lte(param("n", t.integer()))).namedParams()).toEqual(["n"]);
  });
});

describe("subqueries", () => {
  test("a query is an operand of in and exists", () => {
    const authors = from(Post, "p")
      .where(({ p }) => p.views.gt(100))
      .select(({ p }) => p.authorId);
    const q = from(User, "u").where(({ u }) => u.id.in(authors));
    const node = q.ast.wheres[0]?.expr;
    expect(node?.kind).toBe("binary");
    expect(node).toMatchObject({ op: "in", right: { kind: "subquery", query: authors.ast } });
    expect(q.ast.params).toEqual([100]);
    expectConsistent(q);
    const e = from(User, "u").where(({ u }) =>
      exists(
        from(Post, "p").where(({ p }) => p.authorId.eq(u.id).and(p.title.eq(param("title", t.string())))),
      ),
    );
    expect(e.named.map((n) => n.name)).toEqual(["title"]);
    expect(e.toString()).toBe(
      "from users as u where exists (from posts as p where (p.author_id = u.id) and (p.title = :title))",
    );
    expectConsistent(e);
  });

  test("the subquery expression carries the selected value's type", () => {
    const ids = from(Post, "p").select(({ p }) => p.authorId);
    expect(ids[AS_SUBQUERY]().type).toBe(meta(Post).fieldsByName.get("authorId")?.type);
    expect(from(Post, "p")[AS_SUBQUERY]().type).toBeUndefined();
    expect(
      from(Post, "p")
        .select(({ p }) => ({ id: p.id }))
        [AS_SUBQUERY]().type,
    ).toBeUndefined();
    expect(isExpr(ids[AS_SUBQUERY]())).toBe(true);
  });

  test("a query with preloads cannot be a subquery", () => {
    expect(() => exists(from(Post, "p").preload("comments"))).toThrow(/preloads was used as a subquery/);
  });
});

describe("preload", () => {
  const nodes = (q: AnyQuery) => q.ast.preloads;

  test("the short forms become preload nodes, validated against the associations", () => {
    expect(nodes(from(User, "u").preload("posts") as never)).toEqual([
      { kind: "preload", assoc: "posts", from: undefined, query: undefined, nested: [] },
    ]);
    const q = from(User, "u").preload([
      "profile",
      { posts: ["comments", { tags: true }] },
      { orgs: { memberships: "user" } },
    ]);
    expect(q.toString()).toBe(
      "from users as u preload profile, posts { comments, tags }, orgs { memberships { user } }",
    );
    expect(q.ast.params).toEqual([]);
    expectConsistent(q);
  });

  test("several preload calls merge", () => {
    const q = from(User, "u")
      .preload("posts")
      .preload({ posts: "comments" })
      .preload({ posts: { comments: "author" } })
      .preload("profile");
    // Listed in the order User declares its associations.
    expect(q.toString()).toBe("from users as u preload profile, posts { comments { author } }");
    expectConsistent(q);
  });

  test("preload nodes change the shape, their order does not change the merged result", () => {
    const a = from(User, "u").preload("posts");
    expect(a.ast.shape).not.toBe(from(User, "u").ast.shape);
    expect(a.ast.shape).not.toBe(from(User, "u").preload("profile").ast.shape);
  });

  test("an unknown association is refused at any depth, naming it and the known ones", () => {
    expect(() => from(User, "u").preload("nope" as never)).toThrow(
      /preload\("nope"\): User has no association "nope"\. Its associations are: profile, posts, comments, memberships, orgs/,
    );
    expect(() => from(User, "u").preload({ posts: "nope" } as never)).toThrow(
      /preload\(\{ posts: nope \}\): Post has no association "nope"/,
    );
    expect(() => from(User, "u").preload({ posts: true, nope: true } as never)).toThrow(
      /no association "nope"/,
    );
    expect(() => from(User, "u").preload(1 as never)).toThrow(
      /preload\(\) takes an association name.*given a number/,
    );
    expect(() => from(User, "u").preload({ posts: 1 } as never)).toThrow(/at posts it was given a number/);
  });

  test("preload needs whole rows of the root", () => {
    expect(() =>
      from(User, "u")
        .select(({ u }) => u.id)
        .preload("posts"),
    ).toThrow(/preload\(\) attaches associations to whole rows, and this query selects one expression/);
    expect(
      from(User, "u")
        .select(({ u }) => u)
        .preload("posts").ast.preloads,
    ).toHaveLength(1);
    expect(() =>
      from(User, "u")
        .preload("posts")
        .select(({ u }) => ({ id: u.id })),
    ).toThrow(
      /select\(\) was given a select that is not the whole root binding "u", and the query preloads "posts"/,
    );
    expect(
      from(User, "u")
        .preload("posts")
        .select(({ u }) => u).ast.select,
    ).toBeDefined();
  });

  test("the callback form holds the callback's query", () => {
    const q = from(User, "u").preload("posts", (x) =>
      x
        .where(({ posts }) => posts.published)
        .orderBy(({ posts }) => posts.createdAt.desc())
        .limit(3)
        .preload("comments"),
    );
    const node = q.ast.preloads[0];
    expect(node?.assoc).toBe("posts");
    expect(node?.query?.from).toMatchObject({ source: "posts", alias: "posts" });
    expect(node?.query?.params).toEqual([3]);
    expect(node?.nested).toEqual(node?.query?.preloads);
    // The preload's query is a separate statement: none of its values are the outer query's.
    expect(q.ast.params).toEqual([]);
    expect(q.ast.shape).toBe(
      from(User, "u").preload("posts", (x) =>
        x
          .limit(9)
          .orderBy(({ posts }) => posts.id)
          .preload("comments"),
      ).ast.shape,
    );
    expect(q.toString()).toBe("from users as u preload posts (query) { comments }");
    expectConsistent(q);
  });

  test("a callback's limit needs an order, the callback's or the association's", () => {
    expect(() => from(Post, "p").preload("tags", (x) => x.limit(3))).toThrow(
      /limit in preload "tags" needs an orderBy/,
    );
    expect(() => from(Post, "p").preload("tags", (x) => x.offset(3))).toThrow(/needs an orderBy/);
    // User.posts declares orderBy: ["createdAt"].
    expect(from(User, "u").preload("posts", (x) => x.limit(3)).ast.preloads).toHaveLength(1);
    expect(
      from(Post, "p").preload("tags", (x) => x.orderBy(({ tags }) => tags.name).limit(3)).ast.preloads,
    ).toHaveLength(1);
  });

  test("a callback's select must keep the association's key under its field name", () => {
    expect(() =>
      from(User, "u").preload("posts", (x) => x.select(({ posts }) => ({ title: posts.title })) as never),
    ).toThrow(/preload "posts" selects without its key\. Add `authorId: posts\.authorId` to the select\./);
    expect(() =>
      from(User, "u").preload(
        "posts",
        (x) => x.select(({ posts }) => ({ authorId: posts.id, t: posts.title })) as never,
      ),
    ).toThrow(/without its key/);
    expect(() =>
      from(User, "u").preload("posts", (x) => x.select(({ posts }) => posts.authorId) as never),
    ).toThrow(/without its key/);
    expect(() =>
      from(Post, "p").preload("author", (x) => x.select(({ author }) => ({ email: author.email })) as never),
    ).toThrow(/preload "author" selects without its key\. Add `id: author\.id`/);
    const ok = from(User, "u").preload("posts", (x) =>
      x.select(({ posts }) => ({ authorId: posts.authorId, title: posts.title })),
    );
    expect(ok.ast.preloads[0]?.query?.select).toBeDefined();
    // Many-to-many keeps its key in the join table, so the library fetches it.
    expect(
      from(Post, "p").preload("tags", (x) => x.select(({ tags }) => ({ name: tags.name }))).ast.preloads,
    ).toHaveLength(1);
    expect(from(User, "u").preload("posts", (x) => x.select(({ posts }) => posts)).ast.preloads).toHaveLength(
      1,
    );
  });

  test("a callback must return the query it was given", () => {
    expect(() => from(User, "u").preload("posts", (() => 1) as never)).toThrow(
      'query.preloadCallbackResult: preload("posts", callback): the callback must return a query, the one it receives with clauses added; it returned a number. Return the query the callback receives, with clauses added. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-preloadcallbackresult',
    );
    expect(() => from(User, "u").preload("posts", (() => from(Post, "posts")) as never)).not.toThrow();
    expect(() => from(User, "u").preload("posts", (() => from(Post, "p")) as never)).toThrow(
      /must return the query it receives/,
    );
    expect(() => from(User, "u").preload("posts", (() => from(Comment, "posts")) as never)).toThrow(
      /must return the query it receives/,
    );
    expect(() => from(User, "u").preload(["posts"] as never, ((x: AnyQuery) => x) as never)).toThrow(
      /takes one association name first/,
    );
    expect(() => from(User, "u").preload("posts", 1 as never)).toThrow(
      /takes a function from query to query/,
    );
    expect(() => from(User, "u").preload("nope" as never, ((x: AnyQuery) => x) as never)).toThrow(
      /no association "nope"/,
    );
  });

  test("two callbacks for one association, or two sources, are refused", () => {
    const q = from(User, "u").preload("posts", (x) => x.limit(1));
    expect(() => q.preload("posts", (x) => x.limit(2))).toThrow(/preload "posts" is given a callback twice/);
    expect(q.preload({ posts: "comments" }).ast.preloads[0]?.nested.map((n) => n.assoc)).toEqual([
      "comments",
    ]);
    const joined = from(User, "u").joinAssoc("u", "posts", "p").preload({ posts: "p" });
    expect(() => joined.preload("posts")).toThrow(
      /declared twice, once from the binding "p" and once from a separate query/,
    );
  });

  test("the join form fills an association from a binding joined through it", () => {
    const q = from(User, "u")
      .joinAssoc("u", "posts", "p")
      .joinAssoc("p", "comments", "c")
      .preload({ posts: { $from: "p", comments: "c" } });
    expect(q.ast.preloads).toEqual([
      {
        kind: "preload",
        assoc: "posts",
        from: "p",
        query: undefined,
        nested: [{ kind: "preload", assoc: "comments", from: "c", query: undefined, nested: [] }],
      },
    ]);
    expect(q.toString()).toContain("preload posts from p { comments from c }");
    const simple = from(User, "u").joinAssoc("u", "posts", "p").preload({ posts: "p" });
    expect(simple.ast.preloads[0]?.from).toBe("p");
    expect(simple.ast.shape).not.toBe(
      from(User, "u").joinAssoc("u", "posts", "p").preload("posts").ast.shape,
    );
  });

  test("a string is an alias only for a binding joined through that association", () => {
    // `author` is an association of Post, and there is no binding of that name: nested.
    const nested = from(User, "u").joinAssoc("u", "posts", "p").preload({ posts: "author" });
    expect(nested.ast.preloads[0]).toMatchObject({ from: undefined, nested: [{ assoc: "author" }] });
    // A binding named like the string but joined another way is not taken.
    const other = from(User, "u").join(Post, "p", ({ u, p }) => p.authorId.eq(u.id));
    expect(() => other.preload({ posts: "p" } as never)).toThrow(
      /preload\(\{ posts: "p" \}\): "p" is a binding of this query, but it was not joined through the association "posts" from "u", so it cannot fill it\. Join it with joinAssoc\("u", "posts", "p"\)/,
    );
    expect(() => other.preload({ posts: { $from: "p" } } as never)).toThrow(
      'query.preloadFrom: preload({ posts: { $from: "p" } }): $from names the binding to fill "posts" from, which must be joined through that association.',
    );
    expect(() => from(User, "u").preload({ posts: { $from: 1 } } as never)).toThrow(/\$from: a number/);
    // Below a separately loaded association, there is no join to take rows from.
    const below = from(User, "u").joinAssoc("u", "posts", "p").joinAssoc("p", "comments", "c");
    expect(() => below.preload({ posts: { comments: "c" } } as never)).toThrow(
      /"c" is a binding of this query, but it was not joined through the association "comments" from the rows this level is loaded from/,
    );
    // A binding joined through an association of that name, but from another parent, is not taken.
    const elsewhere = from(User, "u")
      .joinAssoc("u", "posts", "p")
      .joinAssoc("p", "author", "a")
      .joinAssoc("a", "posts", "p2");
    expect(() => elsewhere.preload({ posts: "p2" } as never)).toThrow(
      /"p2" is a binding of this query, but it was not joined through the association "posts" from "u"/,
    );
    expect(elsewhere.preload({ posts: "p" }).ast.preloads[0]?.from).toBe("p");
  });

  test("a preload callback's named parameters are the query's", () => {
    const q = from(User, "u").preload("posts", (x) =>
      x.where(({ posts }) => posts.views.gte(param("minViews", t.integer()))),
    );
    expect(q.namedParams()).toEqual(["minViews"]);
    expect(q.named).toEqual([]);
    expect(q.ast.preloads[0]?.query?.params).toEqual([]);
  });
});

describe("hasNamedBinding", () => {
  test("checks the alias, and the schema when given", () => {
    const q = from(User, "u").joinAssoc("u", "posts", "p").joinAssoc("p", "tags", "tg");
    expect(hasNamedBinding(q, "p")).toBe(true);
    expect(hasNamedBinding(q, "p", Post)).toBe(true);
    expect(hasNamedBinding(q, "p", User)).toBe(false);
    expect(hasNamedBinding(q, "x")).toBe(false);
    expect(hasNamedBinding(q, "$tg_join")).toBe(false);
    expect(hasNamedBinding({ ast: q.ast } as never, "u")).toBe(false);
    expect(q.schemaOf("$tg_join")).toBeUndefined();
    expect(q.schemaOf("tg")).toBe(Tag);
    expect(q.schemaOf("nope")).toBeUndefined();
  });
});

describe("immutability", () => {
  test("every method leaves the query it is called on unchanged, and shares what it did not change", () => {
    const base = frozen(
      from(User, "u")
        .joinAssoc("u", "posts", "p")
        .where(({ u }) => u.age.gte(18))
        .orderBy(({ u }) => u.id),
    );
    const snapshot = JSON.stringify(base.ast, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    );
    const derived = [
      base.where(({ p }) => p.published),
      base.where({ role: "admin" }),
      base.orWhere(({ u }) => u.role.eq("admin")),
      base.join(Comment, "c", ({ p, c }) => c.postId.eq(p.id)),
      base.leftJoinAssoc("p", "comments", "c"),
      base.joinAssoc("p", "tags", "tg"),
      base.select(({ u }) => ({ id: u.id })),
      base.distinct(),
      base.groupBy(({ u }) => u.id).having(({ u }) => count(u.id).gt(1)),
      base.orderBy(({ u }) => u.email),
      base.reverseOrder(),
      base.limit(1).offset(2).limit(3),
      base.lock("update"),
      base.schema("tenant"),
      base.exclude("where"),
      base.exclude("orderBy"),
      base.preload("posts").preload({ posts: "comments" }),
      base.preload({ posts: "p" }),
      base.preload("profile", (x) => x),
    ];
    expect(
      JSON.stringify(base.ast, (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value)),
    ).toBe(snapshot);
    for (const q of derived) expectConsistent(q);
    const added = base.where(({ p }) => p.published);
    expect(added.ast).not.toBe(base.ast);
    expect(added.ast.wheres).not.toBe(base.ast.wheres);
    expect(added.ast.joins).toBe(base.ast.joins);
    expect(added.ast.orderBys).toBe(base.ast.orderBys);
    expect(added.ast.from).toBe(base.ast.from);
    expect(added.ast.wheres[0]).toBe(base.ast.wheres[0]);
  });

  test("a base query extended two ways gives two independent queries", () => {
    const active = frozen(from(User, "u").where(({ u }) => u.name.isNotNull()));
    const admins = active.where({ role: "admin" });
    const recent = active.orderBy(({ u }) => u.createdAt.desc()).limit(10);
    expect(admins.ast.wheres).toHaveLength(2);
    expect(admins.ast.orderBys).toHaveLength(0);
    expect(recent.ast.wheres).toHaveLength(1);
    expect(recent.ast.limit).toBeDefined();
    expect(active.ast.limit).toBeUndefined();
  });

  test("callbacks run once, when the clause is added", () => {
    let calls = 0;
    const q = from(User, "u").where(({ u }) => {
      calls += 1;
      return u.age.gte(1);
    });
    q.limit(1).orderBy(({ u }) => u.id);
    q.toString();
    expect(calls).toBe(1);
  });
});

describe("canonical params and shape", () => {
  test("two queries built in different orders have equal shapes and params", () => {
    const a = from(User, "u")
      .limit(10)
      .orderBy(({ u }) => u.age.add(1))
      .where(({ u }) => u.age.gte(18))
      .joinAssoc("u", "posts", "p", ({ p }) => p.views.gt(5))
      .select(({ u }) => ({ x: u.age.mul(2) }));
    const b = from(User, "u")
      .joinAssoc("u", "posts", "p", ({ p }) => p.views.gt(5))
      .select(({ u }) => ({ x: u.age.mul(2) }))
      .where(({ u }) => u.age.gte(18))
      .orderBy(({ u }) => u.age.add(1))
      .limit(10);
    expect(a.ast.shape).toBe(b.ast.shape);
    expect(a.ast.params).toEqual(b.ast.params);
    expect(a.ast.params).toEqual([5, 18, 2, 1, 10]);
    expectConsistent(a);
    expectConsistent(b);
  });

  test("queries that differ only in values share a shape; any structural change gives another", () => {
    const build = (age: number, size: number) =>
      from(User, "u")
        .where(({ u }) => u.age.gte(age))
        .where({ id: [1, 2, 3].slice(0, size) })
        .limit(size);
    expect(build(1, 1).ast.shape).toBe(build(99, 3).ast.shape);
    const base = build(1, 1).ast.shape;
    const variants = [
      from(User, "u").ast.shape,
      build(1, 1).orWhere(({ u }) => u.age.gte(1)).ast.shape,
      build(1, 1).offset(1).ast.shape,
      build(1, 1).distinct().ast.shape,
      build(1, 1).lock("update").ast.shape,
      build(1, 1).lock("share").ast.shape,
      build(1, 1).orderBy(({ u }) => u.id).ast.shape,
      build(1, 1).orderBy(({ u }) => u.id.desc()).ast.shape,
      build(1, 1).groupBy(({ u }) => u.id).ast.shape,
      build(1, 1).select(({ u }) => u.id).ast.shape,
      build(1, 1).schema("s").ast.shape,
      build(1, 1).preload("posts").ast.shape,
      from(User, "v").ast.shape,
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });
});

describe("toString", () => {
  test("renders every expression kind without values", () => {
    const q = from(User, "u").where(({ u }) =>
      u.age
        .between(1, 2)
        .and(u.name.isNull().not())
        .or(u.email.like("x").and(u.role.in(["admin"])))
        .and(u.age.neg().lt(0))
        .and(u.passwordHash.eq("secret"))
        .and(u.email.lower().isNotNull())
        .and(u.settings.pathText("theme").eq("dark"))
        .and(u.age.cast(t.string()).eq("1"))
        .and(fragment`${u.id} > ${fragment.ident("x")}`.as<boolean>()),
    );
    const text = q.toString();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("dark");
    expect(text).toContain("u.age between ? and ?");
    expect(text).toContain("not u.name is null");
    expect(text).toContain("-u.age");
    expect(text).toContain("lower(u.email) is not null");
    expect(text).toContain("u.settings #>> {?}");
    expect(text).toContain("cast(u.age as string)");
    expect(text).toContain("fragment`u.id > x`");
  });

  test("renders aggregates, cases, tuples and other sources", () => {
    const text = render({
      ...from(Post, "p").ast,
      select: {
        kind: "select",
        shape: {
          kind: "tuple",
          items: [
            {
              kind: "expr",
              expr: {
                kind: "aggregate",
                name: "count",
                args: [{ kind: "star" }],
                distinct: true,
                filter: { kind: "literal", value: true },
                over: "w",
              },
              type: undefined,
            },
            {
              kind: "expr",
              expr: {
                kind: "aggregate",
                name: "sum",
                args: [],
                distinct: false,
                filter: undefined,
                over: { kind: "window", partitionBy: [], orderBy: [], frame: undefined },
              },
              type: undefined,
            },
            {
              kind: "expr",
              expr: {
                kind: "case",
                whens: [{ when: { kind: "literal", value: null }, result: { kind: "literal", value: 1 } }],
                else: { kind: "literal", value: 2 },
              },
              type: undefined,
            },
            { kind: "expr", expr: { kind: "case", whens: [], else: undefined }, type: undefined },
            {
              kind: "expr",
              expr: { kind: "tuple", items: [{ kind: "literal", value: false }] },
              type: undefined,
            },
            {
              kind: "expr",
              expr: { kind: "selectedAs", name: "n", expr: { kind: "literal", value: 3 } },
              type: undefined,
            },
            { kind: "expr", expr: { kind: "selectedAs", name: "n", expr: undefined }, type: undefined },
            { kind: "expr", expr: { kind: "nary", op: "and", args: [] }, type: undefined },
            { kind: "expr", expr: { kind: "nary", op: "or", args: [] }, type: undefined },
            {
              kind: "expr",
              expr: {
                kind: "binary",
                op: "has",
                left: { kind: "literal", value: 1 },
                right: { kind: "literal", value: 2 },
              },
              type: undefined,
            },
            {
              kind: "expr",
              expr: { kind: "jsonPath", expr: { kind: "literal", value: 1 }, path: [], asText: false },
              type: undefined,
            },
            { kind: "expr", expr: { kind: "fn", name: "now", args: [] }, type: undefined },
            {
              kind: "expr",
              expr: { kind: "namedParam", name: "k", type: undefined, redact: false },
              type: undefined,
            },
            {
              kind: "expr",
              expr: { kind: "list", value: [1], type: undefined, redact: false },
              type: undefined,
            },
          ],
        },
        constants: [],
      },
      joins: [
        {
          kind: "join",
          type: "inner",
          source: { kind: "cteSource", name: "tree", meta: undefined, alias: "t" },
          on: undefined,
        },
        {
          kind: "join",
          type: "inner",
          source: { kind: "subquerySource", query: from(Tag, "tg").ast, alias: "s" },
          on: undefined,
        },
        {
          kind: "join",
          type: "inner",
          source: { kind: "values", columns: [], rows: [], alias: "v" },
          on: undefined,
        },
        {
          kind: "join",
          type: "inner",
          source: {
            kind: "fragmentSource",
            fragment: { kind: "fragment", strings: ["g()"], args: [] },
            columns: [],
            alias: "g",
          },
          on: undefined,
        },
        {
          kind: "join",
          type: "inner",
          source: { kind: "table", source: "x", meta: undefined, schema: "s", alias: "x" },
          on: { kind: "subquery", query: from(Tag, "tg").ast },
        },
      ],
    });
    expect(text).toMatchInlineSnapshot(
      `"from posts as p inner join tree as t inner join (from tags as tg) as s inner join (values …) as v inner join fragment\`g()\` as g inner join s.x as x on (from tags as tg) select [count(distinct *) filter (where true) over w, sum() over (…), case when null then 1 else 2 end, case  end, (false), 3 as n, n, true, false, 2 = any(1), 1 #> {}, now(), :k, ?]"`,
    );
  });

  test("inspect prints the rendering", () => {
    const q = from(User, "u").limit(1);
    const inspect = (q as unknown as Record<symbol, () => string>)[Symbol.for("nodejs.util.inspect.custom")];
    expect(inspect?.call(q)).toBe("Query<from users as u limit ?>");
  });
});

describe("canonical order, property", () => {
  // Each step adds one clause, with a value from the run; the steps are applied in a random
  // order. Whatever the order, the query must be the same: equal shape, equal params, and
  // caches that agree with walking the AST.
  type Step = (q: AnyQuery, v: number) => AnyQuery;
  type Age = { readonly age: Col<number> };
  const steps: readonly Step[] = [
    (q, v) => q.where((({ u }: { u: Age }) => u.age.gte(v)) as never),
    (q, v) => q.orderBy((({ u }: { u: Age }) => u.age.add(v)) as never),
    (q, v) => q.groupBy((({ u }: { u: Age }) => [u.age.mul(v)]) as never),
    (q, v) => q.limit(v as never),
    (q, v) => q.offset(v as never),
    (q, v) => q.distinct((({ u }: { u: Age }) => u.age.sub(v)) as never),
    (q, v) => q.select((({ u }: { u: Age }) => ({ a: u.age.div(v) })) as never),
    (q, v) => q.lock(fragment`FOR UPDATE ${val(v)}` as never),
    (q, v) =>
      q.join(
        Post as never,
        "p" as never,
        (({ u, p }: { u: { id: Col<number> }; p: { authorId: Col<number>; views: Col<number> } }) =>
          p.authorId.eq(u.id).and(p.views.gt(v))) as never,
      ),
  ];

  test("the clauses of a query can be added in any order", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          steps.map((_, i) => i),
          { minLength: 1 },
        ),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: steps.length, maxLength: steps.length }),
        (order, values) => {
          const sorted = [...order].sort((a, b) => a - b);
          let shuffled = from(User, "u") as unknown as AnyQuery;
          for (const i of order) shuffled = (steps[i] as Step)(shuffled, values[i] as number);
          let canonical = from(User, "u") as unknown as AnyQuery;
          for (const i of sorted) canonical = (steps[i] as Step)(canonical, values[i] as number);
          expect(shuffled.ast.shape).toBe(canonical.ast.shape);
          expect(shuffled.ast.params).toEqual(canonical.ast.params);
          expectConsistent(shuffled);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("less common paths", () => {
  const recent = (lists: number[]) => ({
    [AS_SOURCE](alias: string): SourceParts {
      const binding = { n: new Col(alias, meta(Post).fieldsByName.get("views") as never) };
      return {
        node: {
          kind: "fragmentSource",
          fragment: {
            kind: "fragment",
            strings: ["f(", ")"],
            args: lists.length === 0 ? [] : [listNode(lists, undefined, false)],
          },
          columns: ["n"],
          alias,
        },
        binding,
        meta: undefined,
        params: lists.length === 0 ? [] : [lists],
        lists: lists.length === 0 ? [] : [lists.length],
        named: [],
      };
    },
  });

  test("a source wrapper's binding: its lists, its alias, its object form and its associations", () => {
    const q = from(recent([5, 6]) as never, "r") as unknown as AnyQuery;
    expect(q.ast.listLengths).toEqual([2]);
    expectConsistent(q);
    expect(() => q.join(recent([]) as never, "r" as never, (() => val(true)) as never)).toThrow(
      /alias "r", which this query already uses\. Each binding/,
    );
    expect(() => q.joinAssoc("r" as never, "posts" as never, "p" as never)).toThrow(
      /joinAssoc\("r", "posts", …\): the binding "r" has no schema/,
    );
    expect(show(q.where({ n: 1 } as never).ast.wheres[0]?.expr)).toBe("(eq r.views $1:integer)");
    expect(() => q.where({ x: 1 } as never)).toThrow(
      /names a field that the root binding "r" does not have as a column\. Its columns are: n\./,
    );
    const joined = from(User, "u").join(
      recent([]) as never,
      "r" as never,
      (({ r }: { r: { n: Col<number> } }) => r.n.gt(1)) as never,
    );
    expect(joined.ast.joins[0]?.source.kind).toBe("fragmentSource");
  });

  test("an empty object filter is TRUE", () => {
    expect(show(from(User, "u").where({}).ast.wheres[0]?.expr)).toBe("TRUE");
  });

  test("a schema without associations says so", () => {
    expect(() => from(Article, "a").joinAssoc("a", "x" as never, "b")).toThrow(
      /Its associations are: none\./,
    );
    expect(() => from(Article, "a").preload("x" as never)).toThrow(/Its associations are: none\./);
  });

  test("an error from a nested clause keeps the inner clause's name", () => {
    expect(() =>
      from(User, "u").where(() => exists(from(Post, "p").where(({ p }) => p.views.eq(null as never)))),
    ).toThrow(/^[a-z]+(?:\.\w+)?: where\(\): eq\(\) was given null/);
  });

  test("offset takes a named parameter, and replacing it is checked", () => {
    const q = from(User, "u").offset(param("skip", t.integer()));
    expect(show(q.ast.offset)).toBe(":skip:integer");
    expect(() => q.offset(1)).toThrow(
      /offset\(\) replacing the earlier offset would remove the named parameter "skip"/,
    );
    expect(from(User, "u").offset(1).offset(2).ast.params).toEqual([2]);
  });

  test("preload names are listed once", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(param("v", t.integer())))
      .preload("posts", (x) =>
        x.where(({ posts }) => posts.views.gt(param("v", t.integer()).add(param("w", t.integer())))),
      );
    expect(q.namedParams()).toEqual(["v", "w"]);
    expect(q.exclude("where").namedParams()).toEqual(["v", "w"]);
  });

  test("preload after an object select names it", () => {
    expect(() =>
      from(User, "u")
        .select(({ u }) => ({ id: u.id }))
        .preload("posts"),
    ).toThrow(/this query selects an object/);
  });

  test("a join preload below a separately loaded association is refused", () => {
    const q = from(User, "u").joinAssoc("u", "posts", "p").joinAssoc("p", "comments", "c");
    expect(() => q.preload({ posts: { comments: { $from: "c" } } } as never)).toThrow(
      /joinAssoc\("…", "comments", "c"\)/,
    );
    expect(() => q.preload("posts").preload({ posts: "p" })).toThrow(
      /declared twice, once from a separate query and once from the binding "p"/,
    );
  });

  test("a select's lists, and a merge of lists, parameters and nested constants", () => {
    const q = from(User, "u").select(({ u }) => ({ admin: u.role.in(["admin"]), kind: "x" }));
    expect(q.ast.listLengths).toEqual([1]);
    const merged = q.selectMerge(({ u }) => ({
      n: u.id.in([1, 2]),
      p: u.age.gte(param("minAge", t.integer())),
      deep: { a: "y", b: ["z"] },
    }));
    expect(merged.ast.listLengths).toEqual([1, 2]);
    expect(merged.ast.select?.constants).toEqual(["x", "y", "z"]);
    expect(merged.ast.select?.shape).toMatchObject({
      values: [
        { kind: "expr" },
        { kind: "constant", index: 0 },
        { kind: "expr" },
        { kind: "expr" },
        {
          kind: "object",
          values: [
            { kind: "constant", index: 1 },
            { kind: "tuple", items: [{ kind: "constant", index: 2 }] },
          ],
        },
      ],
    });
    expect(merged.named.map((n) => n.name)).toEqual(["minAge"]);
    expectConsistent(merged);
    expect(merged.toString()).toBe(
      "from users as u select { admin: u.role in ?, kind: <value>, n: u.id in ?, p: u.age >= :minAge, deep: { a: <value>, b: [<value>] } }",
    );
  });

  test("toString of a plain distinct and of a whole-binding select", () => {
    expect(from(User, "u").distinct().toString()).toBe("from users as u distinct");
    expect(
      from(User, "u")
        .select(({ u }) => u)
        .toString(),
    ).toBe("from users as u select u");
  });

  test("a many-to-many through a join schema with a joinWhere on its fields", () => {
    class Team extends Schema("teams", { id: t.integer().primaryKey() }) {
      static leads = manyToMany(() => Person, {
        joinThrough: () => Seat,
        joinKeys: { owner: "teamId", target: "personId" },
        joinWhere: { kind: "lead" },
      });
    }
    class Person extends Schema("people", { id: t.integer().primaryKey() }) {}
    class Seat extends Schema("seats", {
      teamId: t.integer().primaryKey().column("team"),
      personId: t.integer().primaryKey().column("person"),
      kind: t.string().column("seat_kind"),
    }) {}
    const q = from(Team, "tm").joinAssoc("tm", "leads", "pe");
    expect(q.ast.joins.map((j) => show(j.on))).toEqual([
      '(and (eq $pe_join.team tm.id) (eq $pe_join.seat_kind $"lead":string))',
      "(eq pe.id $pe_join.person)",
    ]);
    expectConsistent(q);
  });
});

describe("review, round 1", () => {
  test("a preload callback cannot use a name of the query's with another type, in either order", () => {
    const outer = from(User, "u").where(({ u }) => u.age.gte(param("n", t.integer())));
    expect(() =>
      outer.preload("posts", (x) => x.where(({ posts }) => posts.title.eq(param("n", t.string()))) as never),
    ).toThrow(/named parameter "n" is used with two types, integer and string/);
    const preloaded = from(User, "u").preload("posts", (x) =>
      x.where(({ posts }) => posts.title.eq(param("n", t.string()))),
    );
    expect(() => preloaded.where(({ u }) => u.age.gte(param("n" as never, t.integer())))).toThrow(
      /named parameter "n" is used with two types, string and integer/,
    );
    expect(() =>
      preloaded.preload(
        "profile",
        (x) => x.where(({ profile }) => profile.userId.eq(param("n" as never, t.integer()))) as never,
      ),
    ).toThrow(/two types/);
    // The same name with the same type is shared.
    expect(
      outer
        .preload("posts", (x) => x.where(({ posts }) => posts.views.gte(param("n", t.integer()))))
        .namedParams(),
    ).toEqual(["n"]);
  });

  test("the object form compares an array or JSON column with a whole value, and a scalar column with a list", () => {
    const tags = from(Post, "p").where({ tagList: ["a", "b"] });
    expect(show(tags.ast.wheres[0]?.expr)).toBe('(eq p.tags $["a","b"]:array(string))');
    expect(tags.ast.listLengths).toEqual([]);
    expectConsistent(tags);
    class Doc extends Schema("docs", {
      id: t.integer().primaryKey(),
      body: t.json<{ readonly k: number } | readonly number[]>(),
      list: t.array(t.integer()),
    }) {}
    expect(show(from(Doc, "d").where({ body: [1, 2] }).ast.wheres[0]?.expr)).toBe("(eq d.body $[1,2]:json)");
    expect(show(from(Doc, "d").where({ body: { k: 1 } }).ast.wheres[0]?.expr)).toBe(
      `(eq d.body $${JSON.stringify({ k: 1 })}:json)`,
    );
    expect(show(from(Doc, "d").where({ list: [3] }).ast.wheres[0]?.expr)).toBe(
      "(eq d.list $[3]:array(integer))",
    );
    expect(show(from(Doc, "d").where({ id: [3, 4] }).ast.wheres[0]?.expr)).toBe("(in d.id $[3,4]:integer)");
  });

  test("a right or full join must come before the select and the preloads, and a preload cannot follow one", () => {
    const selected = from(Post, "p").select(({ p }) => p.id);
    expect(() => selected.rightJoin(User, "u", ({ u, p }) => p.authorId.eq(u.id))).toThrow(
      /rightJoin\(\) makes the rows of the bindings before it optional, and this query already has a select.*before select\(\)/,
    );
    expect(() =>
      from(User, "u")
        .preload("posts")
        .fullJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id)),
    ).toThrow(/already has preloads.*before preload\(\)/);
    expect(() =>
      from(Post, "p")
        .rightJoin(User, "u", ({ u, p }) => p.authorId.eq(u.id))
        .preload("comments"),
    ).toThrow(/a right or full join makes optional/);
    expect(() =>
      from(Post, "p")
        .leftJoin(User, "u", ({ u, p }) => p.authorId.eq(u.id))
        .preload("comments"),
    ).not.toThrow();
  });

  test('exclude("groupBy") refuses to leave a having behind', () => {
    const q = from(Post, "p")
      .groupBy(({ p }) => p.authorId)
      .having(({ p }) => count(p.id).gt(1));
    expect(() => q.exclude("groupBy")).toThrow(
      /exclude\("groupBy"\) would leave a having\(\) without its groupBy\(\)\. Exclude "having" first/,
    );
    expect(q.exclude("having").exclude("groupBy").ast.groupBys).toEqual([]);
  });

  test("a named parameter in a plain join's ON is recorded and checked", () => {
    const q = from(User, "u").join(Post, "p", ({ u, p }) =>
      p.authorId.eq(u.id).and(p.views.gte(param("minViews", t.integer()))),
    );
    expect(q.namedParams()).toEqual(["minViews"]);
    expect(q.named.map((n) => n.name)).toEqual(["minViews"]);
    expect(() => q.where(({ u }) => u.email.eq(param("minViews" as never, t.string())))).toThrow(/two types/);
  });

  test("a preload callback's select must take the key from the association's own binding", () => {
    expect(() =>
      from(User, "u").preload(
        "posts",
        (x) =>
          x
            .join(Post, "other", ({ posts, other }) => other.id.eq(posts.id))
            .select(({ posts, other }) => ({ authorId: other.authorId, title: posts.title })) as never,
      ),
    ).toThrow(/preload "posts" selects without its key/);
  });

  test("named is computed once", () => {
    const q = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));
    expect(q.named).toBe(q.named);
    expect(from(User, "u").named).toEqual([]);
  });

  test("selectMerge drops a replaced plain value from the constants", () => {
    const merged = from(Post, "p")
      .select(({ p }) => ({ id: p.id, kind: "old", other: "kept" }))
      .selectMerge(({ p }) => ({ kind: p.title }));
    expect(merged.ast.select?.constants).toEqual(["kept"]);
    const direct = from(Post, "p").select(({ p }) => ({ id: p.id, kind: p.title, other: "kept" }));
    expect(merged.ast.select).toEqual(direct.ast.select);
    const none = from(Post, "p")
      .select(({ p }) => ({ id: p.id }))
      .selectMerge(({ p }) => ({ title: p.title }));
    expect(none.ast.select?.constants).toEqual([]);
  });

  test("an untyped column of a source binding takes a list as IN", () => {
    const binding = { n: fragment`n`.as<number>() };
    registerBinding(binding, { alias: "g", meta: undefined });
    const source = {
      [AS_SOURCE](alias: string): SourceParts {
        return {
          node: {
            kind: "fragmentSource",
            fragment: { kind: "fragment", strings: ["g()"], args: [] },
            columns: ["n"],
            alias,
          },
          binding,
          meta: undefined,
          params: [],
          lists: [],
          named: [],
        };
      },
    };
    const q = (from(source as never, "g") as unknown as AnyQuery).where({ n: [1, 2] } as never);
    expect(show(q.ast.wheres[0]?.expr)).toBe('(in fragment["n"] $[1,2])');
  });
});

describe("review, round 2", () => {
  test("a preload callback's query cannot have a right or full join", () => {
    expect(() =>
      from(User, "u").preload("posts", (x) =>
        x.rightJoin(User, "w", ({ posts, w }) => posts.authorId.eq(w.id)),
      ),
    ).toThrow(/preload\("posts", callback\): the callback's query has a right or full join/);
    expect(() =>
      from(User, "u").preload("posts", (x) =>
        x.fullJoin(User, "w", ({ posts, w }) => posts.authorId.eq(w.id)),
      ),
    ).toThrow(/right or full join/);
    expect(
      from(User, "u").preload("posts", (x) =>
        x.leftJoin(User, "w", ({ posts, w }) => posts.authorId.eq(w.id)),
      ).ast.preloads,
    ).toHaveLength(1);
  });

  test("a clash of named parameters names the clause", () => {
    const q = from(User, "u").where(({ u }) => u.age.gte(param("n", t.integer())));
    const clash = () => param("n" as never, t.string());
    expect(() => q.where(({ u }) => u.email.eq(clash()))).toThrow(
      /^[a-z]+(?:\.\w+)?: where\(\): The named parameter "n"/,
    );
    expect(() => q.orWhere(({ u }) => u.email.eq(clash()))).toThrow(
      /^[a-z]+(?:\.\w+)?: orWhere\(\): The named parameter "n"/,
    );
    expect(() => q.join(Post, "p", ({ p }) => p.title.eq(clash()))).toThrow(
      /^[a-z]+(?:\.\w+)?: join\(\): The named parameter "n"/,
    );
    expect(() => q.joinAssoc("u", "posts", "p", ({ p }) => p.title.eq(clash()))).toThrow(
      /^[a-z]+(?:\.\w+)?: joinAssoc\(\): The named parameter "n"/,
    );
    expect(() => q.select(({ u }) => ({ x: u.email.eq(clash()) }) as never)).toThrow(
      /^[a-z]+(?:\.\w+)?: select\(\): The named/,
    );
    expect(() =>
      q.select(({ u }) => ({ id: u.id })).selectMerge(({ u }) => ({ x: u.email.eq(clash()) }) as never),
    ).toThrow(/^[a-z]+(?:\.\w+)?: selectMerge\(\): The named/);
    expect(() => q.distinct(({ u }) => [u.email.concat(clash())] as never)).toThrow(
      /^[a-z]+(?:\.\w+)?: distinct\(\): The named/,
    );
    expect(() => q.groupBy(({ u }) => [u.email.concat(clash())] as never)).toThrow(
      /^[a-z]+(?:\.\w+)?: groupBy\(\): The named/,
    );
    expect(() => q.orderBy(({ u }) => u.email.concat(clash()) as never)).toThrow(
      /^[a-z]+(?:\.\w+)?: orderBy\(\): The named/,
    );
    expect(() => q.limit(clash() as never)).toThrow(/^[a-z]+(?:\.\w+)?: limit\(\): The named/);
    expect(() => q.lock(fragment`FOR UPDATE ${clash()}` as never)).toThrow(
      /^[a-z]+(?:\.\w+)?: lock\(\): The named/,
    );
    expect(() => q.preload("posts", (x) => x.where(({ posts }) => posts.title.eq(clash())) as never)).toThrow(
      /^[a-z]+(?:\.\w+)?: preload\("posts"\): The named parameter "n"/,
    );
    const preloaded = from(User, "u").preload("posts", (x) =>
      x.where(({ posts }) => posts.title.eq(clash())),
    );
    expect(() => preloaded.where(({ u }) => u.age.gte(param("n" as never, t.integer())))).toThrow(
      /^[a-z]+(?:\.\w+)?: where\(\): The named parameter "n"/,
    );
  });

  test("a column of a custom type stored as json compares a whole value", () => {
    const Raw = defineType<unknown, unknown>({
      name: "raw",
      db: { kind: "json" },
      cast: (input) => ({ success: true, data: input }),
    });
    class Event extends Schema("events", { id: t.integer().primaryKey(), data: t.type(Raw) }) {}
    expect(show(from(Event, "e").where({ data: [1, 2] } as never).ast.wheres[0]?.expr)).toBe(
      "(eq e.data $[1,2]:raw)",
    );
  });
});

describe("review, round 2: nullable named parameters", () => {
  const plain = () => param("n", t.integer());
  const nullable = () => param("n", t.integer().nullable());

  test("one name as nullable and as not nullable is refused within one expression, in both orders", () => {
    expect(() =>
      from(User, "u").where(({ u }) => u.age.gte(plain()).and(u.age.lte(nullable() as never))),
    ).toThrow(
      /^[a-z]+(?:\.\w+)?: where\(\): The named parameter "n" is used with two types, integer and integer \| null/,
    );
    expect(() =>
      from(User, "u").where(({ u }) => u.age.gte(nullable() as never).and(u.age.lte(plain()))),
    ).toThrow(
      /^[a-z]+(?:\.\w+)?: where\(\): The named parameter "n" is used with two types, integer \| null and integer/,
    );
  });

  test("one name as nullable and as not nullable is refused across clauses, in both orders", () => {
    expect(() =>
      from(User, "u")
        .where(({ u }) => u.age.gte(plain()))
        .orderBy(({ u }) => u.age.add(nullable() as never)),
    ).toThrow(
      /^[a-z]+(?:\.\w+)?: orderBy\(\): The named parameter "n" is used with two types, integer and integer \| null/,
    );
    expect(() =>
      from(User, "u")
        .limit(nullable() as never)
        .where(({ u }) => u.age.gte(plain())),
    ).toThrow(
      /^[a-z]+(?:\.\w+)?: where\(\): The named parameter "n" is used with two types, integer \| null and integer/,
    );
  });

  test("the same nullability on both sides is accepted, also through redaction", () => {
    expect(
      from(User, "u")
        .where(({ u }) => u.age.gte(nullable() as never).and(u.age.lte(nullable() as never)))
        .namedParams(),
    ).toEqual(["n"]);
    expect(
      from(User, "u")
        .where(({ u }) => u.age.gte(plain()))
        .orderBy(({ u }) => u.age.add(plain()))
        .namedParams(),
    ).toEqual(["n"]);
    // A parameter beside a redacted field is re-made redacted, and keeps its nullability.
    expect(() =>
      from(User, "u")
        .where(({ u }) => u.passwordHash.eq(param("h", t.string().nullable()) as never))
        .where(({ u }) => u.email.eq(param("h" as never, t.string()))),
    ).toThrow(
      /^[a-z]+(?:\.\w+)?: where\(\): The named parameter "h" is used with two types, string \| null and string/,
    );
  });
});

describe("review, round 3", () => {
  test("two field types that are both numbers are told apart at run time", () => {
    expect(() =>
      from(User, "u")
        .where(({ u }) => u.age.gte(param("k", t.integer())))
        .where(({ u }) => u.id.gte(param("k", t.bigint({ mode: "number" })))),
    ).toThrow(
      /^[a-z]+(?:\.\w+)?: where\(\): The named parameter "k" is used with two types, integer and bigint\(number\)/,
    );
  });

  test("two different enums under one name are named as two types", () => {
    expect(() =>
      from(User, "u")
        .where(({ u }) => u.role.eq(param("r", t.enum(["admin", "member"]))))
        .where(({ u }) => u.role.eq(param("r", t.enum(["admin"])) as never)),
    ).toThrow(/used with two types, enum and another enum type \(other values or options\)/);
  });

  test("a replaced limit, offset or lock is checked against what remains, not against what it replaces", () => {
    const n = (type: "integer" | "number") =>
      param("n", type === "integer" ? t.integer() : t.bigint({ mode: "number" }));
    const limited = from(User, "u")
      .limit(n("integer"))
      .limit(n("number") as never);
    expect(limited.namedParams()).toEqual(["n"]);
    expect(limited.named[0]?.type?.name).toBe("bigint(number)");
    expect(
      from(User, "u")
        .offset(n("integer"))
        .offset(n("number") as never)
        .namedParams(),
    ).toEqual(["n"]);
    expect(
      from(User, "u")
        .lock(fragment`FOR UPDATE ${n("integer")}`)
        .lock(fragment`FOR UPDATE ${n("number")}` as never)
        .namedParams(),
    ).toEqual(["n"]);
    expect(from(User, "u").limit(10).limit(n("integer")).namedParams()).toEqual(["n"]);
    // A name the rest of the query still uses is checked as before.
    expect(() =>
      from(User, "u")
        .where(({ u }) => u.age.gte(n("integer")))
        .limit(n("integer"))
        .limit(n("number") as never),
    ).toThrow(/^[a-z]+(?:\.\w+)?: limit\(\): The named parameter "n" is used with two types/);
  });
});

describe("review, round 4", () => {
  test("a clash among a select's own expressions names the clause", () => {
    expect(() =>
      from(User, "u").select(({ u }) => ({
        a: u.age.eq(param("n", t.integer())),
        b: u.email.eq(param("n" as never, t.string())),
      })),
    ).toThrow(
      /^[a-z]+(?:\.\w+)?: select\(\): The named parameter "n" is used with two types, integer and string/,
    );
    expect(() =>
      from(User, "u")
        .select(({ u }) => ({ id: u.id }))
        .selectMerge(({ u }) => ({
          a: u.age.eq(param("n", t.integer().nullable()) as never),
          b: [u.age.gt(param("n", t.integer()))],
        })),
    ).toThrow(
      /^[a-z]+(?:\.\w+)?: selectMerge\(\): The named parameter "n" is used with two types, integer \| null and integer/,
    );
  });

  test("an error that is not a QueryError from a select's expressions passes through", () => {
    const named = param("n", t.integer());
    const broken = Object.create(named) as typeof named;
    Object.defineProperty(broken, "named", {
      get() {
        throw new TypeError("boom");
      },
    });
    expect(() => from(User, "u").select(() => ({ a: broken }))).toThrow(TypeError);
  });
});
