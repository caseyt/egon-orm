// dynamic, field, prepare, tuple, selectedAs, and how the step 09 clauses are rendered.
import { Membership, Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { CompiledQuery } from "../../contracts/adapter.js";
import {
  count,
  cte,
  dynamic,
  field,
  fragment,
  from,
  lit,
  param,
  prepare,
  rowNumber,
  selectedAs,
  sum,
  t,
  tuple,
  val,
} from "../../index.js";
import { render } from "../builder.js";
import { canonical, compiled } from "./test-helpers.js";

describe("dynamic", () => {
  const adult = dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18));
  const admin = dynamic({ u: User }, ({ u }) => u.role.eq("admin"));

  test("is accepted by every clause that takes a callback", () => {
    const byEmail = dynamic({ u: User }, ({ u }) => u.email);
    const shape = dynamic({ u: User }, ({ u }) => ({ id: u.id }));
    const q = from(User, "u")
      .join(Post, "p", adult.and(dynamic({ p: Post, u: User }, ({ p, u }) => p.authorId.eq(u.id))))
      .where(admin)
      .orWhere(adult.not())
      .groupBy(byEmail)
      .having(dynamic({ u: User }, () => count().gt(0)))
      .orderBy(byEmail)
      .select(shape);
    expect(canonical(q)).toBe(true);
    expect(compiled(q).sql).toBe(
      'select "u"."id" as "c0" from "users" as "u" inner join "posts" as "p" on "u"."age" >= $1 and "p"."author_id" = "u"."id" where "u"."role" = $2 or not ("u"."age" >= $3) group by "u"."email" having count(*) > $4 order by "u"."email" asc',
    );
  });

  test("folds from dynamic.true() and dynamic.false()", () => {
    const all = [adult, admin].reduce((acc, f) => acc.and(f), dynamic.true());
    const any = [adult, admin].reduce((acc, f) => acc.or(f), dynamic.false());
    expect(compiled(from(User, "u").where(all)).sql).toMatch(
      /where true and "u"."age" >= \$1 and "u"."role" = \$2$/,
    );
    expect(compiled(from(User, "u").where(any)).sql).toMatch(
      /where false or "u"."age" >= \$1 or "u"."role" = \$2$/,
    );
  });

  test("checks the bindings it was given as schemas", () => {
    expect(() => from(Post, "u" as never).where(admin as never)).toThrow(
      /needs the binding "u" of User, which this query binds to another schema/,
    );
    expect(() => from(Post, "p").where(admin as never)).toThrow(
      /needs the binding "u" of User, which this query does not have/,
    );
    // A combination needs the bindings of both sides.
    expect(() => from(Post, "p").where(dynamic.true().and(admin) as never)).toThrow(/binding "u"/);
    expect(() => from(Post, "p").where(admin.and(dynamic.true()) as never)).toThrow(/binding "u"/);
    expect(() => from(Post, "p").where(admin.and(admin) as never)).toThrow(/binding "u"/);
    expect(() => from(Post, "p").where(admin.not() as never)).toThrow(/binding "u"/);
  });

  test("and, or and not need conditions", () => {
    const notACondition = dynamic({ u: User }, () => 5);
    expect(() => from(User, "u").where(adult.and(notACondition as never))).toThrow(
      /both sides must be conditions/,
    );
    expect(() =>
      from(User, "u").where((notACondition as unknown as typeof adult).or(adult) as never),
    ).toThrow(/both sides must be conditions/);
    expect(() => from(User, "u").where((notACondition as unknown as typeof adult).not() as never)).toThrow(
      /both sides must be conditions/,
    );
    expect(() => adult.and((() => lit(true)) as never)).toThrow(/takes another dynamic expression/);
  });

  test("checks its arguments", () => {
    expect(() => dynamic(5 as never)).toThrow(/takes a callback/);
    expect(() => dynamic("u" as never, (() => lit(true)) as never)).toThrow(/takes the schemas it needs/);
    expect(() => dynamic({ u: "users" } as never, (() => lit(true)) as never)).toThrow(
      /must name a schema class/,
    );
    expect(() => dynamic({ u: User }, 5 as never)).toThrow(/takes a callback second/);
  });

  test("keeps the named parameters of what it holds", () => {
    const min = dynamic({ u: User }, ({ u }) => u.age.gte(param("min", t.integer())));
    const q = from(User, "u").where(min.and(admin));
    expect(q.namedParams()).toEqual(["min"]);
  });
});

describe("field", () => {
  test("picks a column by a name known at run time", () => {
    from(User, "u").where(({ u }) => {
      expect(field(u, "email")).toBe(u.email);
      const name: string = "age";
      expect(field(u, name)).toBe(u.age);
      return lit(true);
    });
  });

  test("refuses a name that is not a column", () => {
    from(User, "u").where(({ u }) => {
      expect(() => field(u, "password")).toThrow(
        /"password", which is not a column of the binding\. Its columns are: id, email/,
      );
      expect(() => field(u, "$schema")).toThrow(/"\$schema"/);
      expect(() => field(u, 3 as never)).toThrow(/a number/);
      expect(() => field(null as never, "id")).toThrow(/takes a binding first/);
      return lit(true);
    });
  });
});

describe("prepare", () => {
  const byEmail = prepare(
    from(User, "u")
      .where(({ u }) => u.email.eq(param("email", t.string())))
      .limit(1),
  );

  function counting(): { readonly compile: (ast: unknown) => CompiledQuery; readonly calls: () => number } {
    let calls = 0;
    const plan = {
      sql: "x",
      slots: [],
      output: undefined,
      schema: undefined,
      decoder: undefined,
    } as CompiledQuery;
    return {
      compile: () => {
        calls++;
        return { ...plan };
      },
      calls: () => calls,
    };
  }

  test("compiles once per adapter, operation and database schema, and keeps the plan", () => {
    const a = counting();
    const b = counting();
    const first = byEmail.plan(a as never);
    expect(byEmail.plan(a as never, "all", undefined)).toBe(first);
    expect(a.calls()).toBe(1);
    const other = byEmail.plan(b as never);
    expect(other).not.toBe(first);
    expect(byEmail.plan(b as never)).toBe(other);
    const tenant = byEmail.plan(a as never, "all", "tenant_1");
    expect(byEmail.plan(a as never, "all", "tenant_1")).toBe(tenant);
    expect(byEmail.plan(a as never, "deleteAll", undefined)).toBe(byEmail.plan(a as never, "deleteAll"));
    expect(a.calls()).toBe(3);
    expect(b.calls()).toBe(1);
  });

  test("is the query's AST, named parameters and rendering", () => {
    const q = from(User, "u").where(({ u }) => u.email.eq(param("email", t.string())));
    const prepared = prepare(q);
    expect(prepared.ast).toBe(q.ast);
    expect(prepared.named).toEqual(q.named);
    expect(prepared.namedParams()).toEqual(["email"]);
    expect(prepared.toString()).toBe(q.toString());
    expect(() => prepare({ ast: q.ast } as never)).toThrow(/prepare\(\) takes a query/);
  });
});

describe("tuple", () => {
  test("binds plain values with the type of the expression at the same position on the other side", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const q = from(Post, "p").where(({ p }) => tuple(at, 7).gt(tuple(p.createdAt, p.id)));
    expect(compiled(q).sql).toMatch(/where \(\$1, \$2\) > \("p"."created_at", "p"."id"\)$/);
    const where = q.ast.wheres[0]?.expr;
    const left = where?.kind === "binary" && where.left.kind === "tuple" ? where.left.items : [];
    expect(left.map((node) => (node.kind === "param" ? node.type?.name : undefined))).toEqual([
      "timestamp",
      "bigint(number)",
    ]);
    expect(canonical(q)).toBe(true);
  });

  test("every comparison operator, and redaction from the other side", () => {
    const q = from(Membership, "m").where(({ m }) =>
      tuple(m.orgId, m.userId)
        .eq(tuple("a", 1))
        .and(tuple(m.orgId, m.userId).neq(tuple("b", 2)))
        .and(tuple(m.userId).lte(tuple(3)))
        .and(tuple(m.userId).gte(tuple(0))),
    );
    expect(compiled(q).sql).toMatch(
      /\("m"."org_id", "m"."user_id"\) = \(\$1, \$2\) and \("m"."org_id", "m"."user_id"\) <> \(\$3, \$4\) and row\("m"."user_id"\) <= row\(\$5\) and row\("m"."user_id"\) >= row\(\$6\)/,
    );
    from(User, "u").where(({ u }) => {
      const condition = tuple(u.passwordHash, u.id).lt(tuple("x", 1));
      const node = condition.node.kind === "binary" ? condition.node.right : undefined;
      expect(node?.kind === "tuple" ? node.items[0] : undefined).toMatchObject({ redact: true });
      return condition;
    });
  });

  test("refuses rows that cannot be compared", () => {
    from(Post, "p").where(({ p }) => {
      expect(() => tuple(p.id, p.views).lt(tuple(1) as never)).toThrow(/have 2 and 1 items/);
      expect(() => tuple(1, 2).lt(tuple(3, 4))).toThrow(/position 1 of the rows has no type on either side/);
      expect(() => tuple(p.id, val(2)).lt(tuple(3, 4))).toThrow(/position 2/);
      expect(() => tuple(p.id).lt(tuple(null as never) as never)).toThrow(/tuple\(\) was given null/);
      expect(() => tuple(p.id).lt([1] as never)).toThrow(/takes another tuple/);
      expect(() => tuple(p.id, lit(null) as never).lt(tuple(1, p.views) as never)).toThrow(/was given null/);
      return lit(true);
    });
    expect(() => (tuple as () => unknown)()).toThrow(/at least one item/);
    expect(() => tuple(1, undefined as never)).toThrow(/undefined/);
  });
});

describe("selectedAs", () => {
  test("names a selected expression and refers to it", () => {
    const named = selectedAs(sum(val(1, t.integer())), "total");
    expect(named.node).toMatchObject({ kind: "selectedAs", name: "total" });
    expect(named.type?.name).toBe("bigint(number)");
    expect(selectedAs("total").node).toEqual({ kind: "selectedAs", name: "total", expr: undefined });
  });

  test("checks its arguments", () => {
    expect(() => selectedAs("")).toThrow(/a non-empty string/);
    expect(() => selectedAs(3 as never, "x")).toThrow(/takes an expression to name first/);
  });

  test("a reference cannot be selected itself", () => {
    expect(() => compiled(from(Post, "p").select(() => ({ t: selectedAs("total") })))).toThrow(
      /cannot be selected itself/,
    );
  });
});

describe("rendering", () => {
  test("toString shows CTEs, windows, set operations, assignments and returning lists", () => {
    const recent = from(Post, "p").select(({ p }) => ({ id: p.id }));
    const q = from(cte("recent", recent), "r")
      .withCte("recent", recent, { recursive: true })
      .windows({ w: ({ r }) => ({ partitionBy: [r.id], orderBy: [r.id.desc()] }) })
      .select(({ r }) => ({ id: r.id, n: rowNumber().over("w") }));
    expect(q.toString()).toBe(
      "with recursive recent as (from posts as p select { id: p.id }) from recent as r window w as (partition by r.id order by r.id desc) select { id: r.id, n: rowNumber() over w }",
    );
    expect(
      from(User, "u")
        .select(({ u }) => ({ id: u.id }))
        .unionAll(from(User, "v").select(({ v }) => ({ id: v.id })))
        .toString(),
    ).toBe("from users as u select { id: u.id } union all (from users as v select { id: v.id })");
    expect(
      from(Post, "p")
        .set({ views: 1 })
        .returning(({ p }) => p.id)
        .toString(),
    ).toBe("from posts as p set views = ? returning p.id");
    expect(from(User, "u").withCte("plain", from(Post, "p")).union(from(User, "v")).toString()).toBe(
      "with plain as (from posts as p) from users as u union (from users as v)",
    );
    const withFragment = {
      ...from(User, "u").ast,
      ctes: [
        {
          kind: "cte",
          name: "f",
          query: fragment`select 1`.node,
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
      ],
    };
    expect(render(withFragment as never)).toBe("with f as (fragment`select 1`) from users as u");
    const frame = from(Post, "p").windows({
      f: () => ({ frame: fragment`rows ${val(1, t.integer())} preceding` }),
    });
    expect(frame.toString()).toBe("from posts as p window f as (fragment`rows ? preceding`)");
  });
});
