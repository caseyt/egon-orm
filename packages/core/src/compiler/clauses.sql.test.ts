import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { OutputPlan } from "../contracts/adapter.js";
import type { QueryAst } from "../contracts/query.js";
import { from } from "../index.js";
import { binaryNode, fragmentNode, orderNode } from "../query/ast.js";
import { meta } from "../schema/index.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { CLAUSE_CASES } from "./sql-cases.js";
import {
  AuditLog,
  bareQuery,
  col,
  DIALECTS,
  rebuild,
  run,
  selectBinding,
  selectObject,
  tableOf,
} from "./sql-fixtures.js";

describe.each(DIALECTS)("ordering, paging, locks and database schemas on $name", (dialect) => {
  for (const sqlCase of CLAUSE_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});

type Row = Extract<OutputPlan, { kind: "row" }>;

function compile(ast: QueryAst, schema?: string) {
  return createCompiler(postgresDialect).compile(ast, "all", schema);
}

describe("database schemas: resolution and provenance", () => {
  test("the argument is the weakest position", () => {
    const plan = compile(from(User, "u").ast, "tenant_1");
    expect(plan.schema).toBe("tenant_1");
    expect((plan.output as Row).schema).toBe("tenant_1");
  });

  test("the query's schema wins over the argument", () => {
    const plan = compile(from(User, "u").schema("archive").ast, "tenant_1");
    expect(plan.schema).toBe("archive");
    expect((plan.output as Row).schema).toBe("archive");
  });

  test("a schema's declared database schema wins over the query's and the argument", () => {
    const plan = compile(from(AuditLog, "a").schema("archive").ast, "tenant_1");
    expect(plan.schema).toBe("audit");
    expect((plan.output as Row).schema).toBe("audit");
  });

  test("a source's own database schema wins over everything", () => {
    const ast = rebuild(bareQuery(tableOf(AuditLog, "a", "elsewhere")), { schema: "archive" });
    const plan = compile(ast, "tenant_1");
    expect(plan.sql).toContain('from "elsewhere"."audit_logs" as "a"');
    expect(plan.schema).toBe("elsewhere");
  });

  test("each table of one statement resolves on its own, and each row leaf carries its own", () => {
    const ast = rebuild(from(User, "u").ast, {
      joins: [
        {
          kind: "join",
          type: "inner",
          source: tableOf(Post, "p", "archive"),
          on: binaryNode("eq", col("p", "author_id"), col("u", "id")),
        },
        {
          kind: "join",
          type: "inner",
          source: tableOf(AuditLog, "a"),
          on: binaryNode("eq", col("a", "user_id"), col("u", "id")),
        },
      ],
      select: {
        kind: "select",
        shape: {
          kind: "tuple",
          items: [
            { kind: "binding", binding: "u", meta: meta(User) },
            { kind: "binding", binding: "p", meta: meta(Post) },
            { kind: "binding", binding: "a", meta: meta(AuditLog) },
          ],
        },
        constants: [],
      },
    });
    const plan = compile(ast, "tenant_1");
    const items = (plan.output as Extract<OutputPlan, { kind: "tuple" }>).items as readonly Row[];
    expect(items.map((row) => row.schema)).toEqual(["tenant_1", "archive", "audit"]);
    expect(plan.schema).toBe("tenant_1");
  });

  test("a row read through a subquery carries the inner table's schema", () => {
    const inner = from(Post, "p").schema("archive").ast;
    const ast = rebuild(bareQuery({ kind: "subquerySource", query: inner, alias: "s" }), {
      select: selectBinding("s", meta(Post)),
    });
    const plan = compile(ast, "tenant_1");
    expect((plan.output as Row).schema).toBe("archive");
    expect(plan.sql).toContain('from "archive"."posts" as "p"');
    // The root is not a table: the statement has no table schema of its own.
    expect(plan.schema).toBeUndefined();
  });

  test("a subquery that sets no schema inherits the enclosing query's", () => {
    const ast = rebuild(bareQuery({ kind: "subquerySource", query: from(Post, "p").ast, alias: "s" }), {
      select: selectBinding("s", meta(Post)),
      schema: "archive",
    });
    const plan = compile(ast, "tenant_1");
    expect(plan.sql).toContain('from "archive"."posts" as "p"');
    expect((plan.output as Row).schema).toBe("archive");
  });

  test("a set operation whose branches agree keeps the schema", () => {
    const ast = rebuild(from(Post, "p").schema("archive").ast, {
      combinations: [{ kind: "combination", op: "union", all: true, query: from(Post, "p").ast }],
    });
    const plan = compile(ast, "tenant_1");
    expect(plan.sql).toBe(
      `${compile(from(Post, "p").ast, "archive").sql} union all (${compile(from(Post, "p").ast, "archive").sql})`,
    );
    expect((plan.output as Row).schema).toBe("archive");
  });

  test("a set operation whose branches differ has no provenance: the leaf takes the declared schema", () => {
    const ast = rebuild(from(User, "u").ast, {
      combinations: [
        { kind: "combination", op: "union", all: false, query: from(User, "u").schema("archive").ast },
      ],
    });
    expect((compile(ast, "tenant_1").output as Row).schema).toBe(meta(User).schema);
  });

  test("a row read through a CTE carries the CTE body's schema", () => {
    const ast = rebuild(bareQuery({ kind: "cteSource", name: "recent", meta: meta(Post), alias: "r" }), {
      ctes: [
        {
          kind: "cte",
          name: "recent",
          query: from(Post, "p").schema("archive").ast,
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
      ],
      select: selectBinding("r", meta(Post)),
    });
    const plan = compile(ast, "tenant_1");
    expect((plan.output as Row).schema).toBe("archive");
    expect(plan.schema).toBeUndefined();
  });

  test("a CTE with a fragment body has no provenance", () => {
    const ast = rebuild(bareQuery({ kind: "cteSource", name: "raw", meta: meta(Post), alias: "r" }), {
      ctes: [
        {
          kind: "cte",
          name: "raw",
          query: fragmentNode(["select * from posts"], []),
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
      ],
      select: selectBinding("r", meta(Post)),
    });
    const plan = compile(ast, "tenant_1");
    expect(plan.sql).toMatch(/^with "raw" as \(select \* from posts\) select "r"\."id" as "c0"/);
    expect((plan.output as Row).schema).toBe(meta(Post).schema);
  });

  test("a recursive CTE's rows carry the first branch's schema", () => {
    const step = rebuild(bareQuery({ kind: "cteSource", name: "chain", meta: meta(Post), alias: "c" }), {
      select: selectBinding("c", meta(Post)),
    });
    const body = rebuild(from(Post, "p").schema("archive").ast, {
      combinations: [{ kind: "combination", op: "union", all: true, query: step }],
    });
    const ast = rebuild(bareQuery({ kind: "cteSource", name: "chain", meta: meta(Post), alias: "x" }), {
      ctes: [
        {
          kind: "cte",
          name: "chain",
          query: body,
          operation: "all",
          recursive: true,
          materialized: undefined,
        },
      ],
      select: selectBinding("x", meta(Post)),
    });
    const plan = compile(ast, "tenant_1");
    expect(plan.sql.startsWith('with recursive "chain" as (select "p"."id" as "id"')).toBe(true);
    expect((plan.output as Row).schema).toBe("archive");
  });
});

describe("clause errors", () => {
  test("a lock clause the dialect does not list is refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      lock: { kind: "lock", clause: "FOR UPDATE; drop table users" },
    });
    expect(() => compile(ast)).toThrow(
      'The lock clause "FOR UPDATE; drop table users" is not one postgres accepts as a string; use a fragment.',
    );
  });

  test("a lock that is neither a clause nor a fragment is refused", () => {
    const ast = rebuild(from(User, "u").ast, { lock: { kind: "lock", clause: col("u", "id") as never } });
    expect(() => compile(ast)).toThrow("A lock is a lock clause or a fragment.");
  });

  test("a lock on a set operation is refused", () => {
    const ast = rebuild(from(User, "u").lock("update").ast, {
      combinations: [{ kind: "combination", op: "union", all: false, query: from(User, "u").ast }],
    });
    expect(() => compile(ast)).toThrow(
      "A row lock cannot be combined with union(), intersect() or except().",
    );
  });

  test("an unknown sort direction or nulls order is refused", () => {
    const base = from(User, "u").ast;
    expect(() =>
      compile(rebuild(base, { orderBys: [orderNode(col("u", "id"), "up" as never, undefined)] })),
    ).toThrow('Unknown sort direction "up".');
    expect(() =>
      compile(rebuild(base, { orderBys: [orderNode(col("u", "id"), "asc", "middle" as never)] })),
    ).toThrow('Unknown nulls order "middle".');
  });

  test("order by on a set operation must name a selected expression", () => {
    const ast = rebuild(from(User, "u").ast, {
      select: selectObject({ id: col("u", "id") }),
      combinations: [
        {
          kind: "combination",
          op: "union",
          all: false,
          query: from(User, "u").select(({ u }) => ({ id: u.id })).ast,
        },
      ],
      orderBys: [orderNode(col("u", "email"), "asc", undefined)],
    });
    expect(() => compile(ast)).toThrow(
      /sorts the combined rows, so it can only use expressions the query selects/,
    );
  });

  test("order by on a set operation finds a selected column of a whole row", () => {
    const ast = rebuild(from(User, "u").ast, {
      combinations: [{ kind: "combination", op: "union", all: false, query: from(User, "u").ast }],
      orderBys: [orderNode(col("u", "email"), "desc", undefined)],
    });
    expect(compile(ast).sql.endsWith(' order by "c1" desc')).toBe(true);
  });

  test("an unknown set operation is refused", () => {
    const ast = rebuild(from(User, "u").ast, {
      combinations: [{ kind: "combination", op: "merge" as never, all: false, query: from(User, "u").ast }],
    });
    expect(() => compile(ast)).toThrow('Unknown set operation "merge".');
  });
});
