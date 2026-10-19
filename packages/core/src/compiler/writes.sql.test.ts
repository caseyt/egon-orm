import { Post, Tag, User, UserSettings } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { InsertPlanOptions, OutputPlan } from "../contracts/adapter.js";
import type { QueryAst } from "../contracts/query.js";
import type { FieldMeta, SchemaMeta } from "../contracts/schema.js";
import { from, t } from "../index.js";
import { binaryNode, literalNode } from "../query/ast.js";
import { meta } from "../schema/index.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect, type SqlDialect } from "./dialect.js";
import { BULK_CASES, WRITE_CASES } from "./sql-cases.js";
import {
  AuditLog,
  col,
  DIALECTS,
  frag,
  rebuild,
  run,
  selectOne,
  tableOf,
  typeOf,
  value,
} from "./sql-fixtures.js";

describe.each(DIALECTS)("bulk updates and deletes on $name", (dialect) => {
  for (const sqlCase of BULK_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});

describe.each(DIALECTS)("row-level writes, fragments and explain on $name", (dialect) => {
  for (const sqlCase of WRITE_CASES) {
    test(sqlCase.name, () => {
      expect(run(createCompiler(dialect), sqlCase)).toEqual(sqlCase.expected[dialect.name]);
    });
  }
});

const users = meta(User);
const tags = meta(Tag);
const field = (schemaMeta: SchemaMeta, name: string): FieldMeta =>
  schemaMeta.fieldsByName.get(name) as FieldMeta;
const id = field(users, "id");
const email = field(users, "email");
const name = field(users, "name");
const lockVersion = field(users, "lockVersion");
const one = (returning: readonly FieldMeta[] = []): InsertPlanOptions => ({
  source: { kind: "values", rows: 1 },
  returning,
  onConflict: undefined,
});

describe("queries nested in a row-level write take the write's database schema", () => {
  const posts = meta(Post);
  const authorId = posts.fieldsByName.get("authorId") as FieldMeta;
  const title = posts.fieldsByName.get("title") as FieldMeta;
  const firstUser = (q: { readonly ast: QueryAst }) =>
    ({
      kind: "subquery",
      query: rebuild(q.ast, { select: selectOne(col("u", "id")), limit: value(1) }),
    }) as const;

  test("INSERT … SELECT: the query inherits it, unless it sets its own", () => {
    const insert = (query: QueryAst) =>
      createCompiler(postgresDialect).compileInsert(
        posts,
        [authorId, title],
        { source: { kind: "query", query }, returning: [], onConflict: undefined },
        "tenant_1",
      ).sql;
    const select = from(User, "u").select(({ u }) => [u.id, u.email]);
    expect(insert(select.ast)).toBe(
      'insert into "tenant_1"."posts" ("author_id", "title") select "u"."id" as "c0", "u"."email" as "c1" from "tenant_1"."users" as "u"',
    );
    expect(insert(select.schema("archive").ast)).toContain('from "archive"."users" as "u"');
    expect(insert(from(AuditLog, "a").select(({ a }) => [a.id, a.action]).ast)).toContain(
      'from "audit"."audit_logs" as "a"',
    );
  });

  test("a subquery in a cell inherits it, unless it sets its own", () => {
    const insert = (q: { readonly ast: QueryAst }) =>
      createCompiler(postgresDialect).compileInsert(
        posts,
        [authorId, title],
        {
          source: { kind: "cells", rows: [[{ kind: "expr", expr: firstUser(q) }, { kind: "value" }]] },
          returning: [],
          onConflict: undefined,
        },
        "tenant_1",
      ).sql;
    expect(insert(from(User, "u"))).toBe(
      'insert into "tenant_1"."posts" ("author_id", "title") values ((select "u"."id" as "c0" from "tenant_1"."users" as "u" limit $1), $2)',
    );
    expect(insert(from(User, "u").schema("archive"))).toContain('from "archive"."users" as "u"');
  });

  test("a subquery in a fragment conflict target inherits it", () => {
    const tags = meta(Tag);
    const name = tags.fieldsByName.get("name") as FieldMeta;
    const plan = createCompiler(postgresDialect).compileInsert(
      tags,
      [name],
      {
        source: { kind: "values", rows: 1 },
        returning: [],
        onConflict: { target: frag`(name) where id <> (${firstUser(from(User, "u"))})`, update: "all" },
      },
      "tenant_1",
    );
    expect(plan.sql).toContain(
      'where id <> ((select "u"."id" as "c0" from "tenant_1"."users" as "u" limit $2))',
    );
  });

  test("without a schema argument nothing is inherited", () => {
    const plan = createCompiler(postgresDialect).compileInsert(
      posts,
      [authorId, title],
      {
        source: {
          kind: "cells",
          rows: [[{ kind: "expr", expr: firstUser(from(User, "u")) }, { kind: "value" }]],
        },
        returning: [],
        onConflict: undefined,
      },
      undefined,
    );
    expect(plan.sql).toContain('from "users" as "u"');
  });
});

describe("what a row-level write returns", () => {
  test("its returning list is an object of the fields, loaded with their types", () => {
    const plan = createCompiler(postgresDialect).compileInsert(users, [email], one([id, email]), undefined);
    expect(plan.output).toEqual({
      kind: "object",
      keys: ["id", "email"],
      values: [
        { kind: "value", alias: "c0", type: id.type },
        { kind: "value", alias: "c1", type: email.type },
      ],
    });
  });

  test("with nothing to return there is no output plan", () => {
    expect(
      createCompiler(postgresDialect).compileInsert(users, [email], one(), undefined).output,
    ).toBeUndefined();
  });

  test("the plan's schema is the argument, else the schema's declared one", () => {
    const compiler = createCompiler(postgresDialect);
    expect(compiler.compileDelete(users, [id], [], "tenant_1").schema).toBe("tenant_1");
    expect(compiler.compileDelete(users, [id], [], undefined).schema).toBeUndefined();
    const audit = meta(AuditLog);
    expect(compiler.compileDelete(audit, [field(audit, "id")], [], undefined).schema).toBe("audit");
    expect(compiler.compileDelete(audit, [field(audit, "id")], [], "tenant_1").sql).toBe(
      'delete from "tenant_1"."audit_logs" where "id" = $1',
    );
  });

  test("slots carry each field's redaction", () => {
    const hash = field(users, "passwordHash");
    const plan = createCompiler(postgresDialect).compileUpdate(users, [hash], [id], [], undefined);
    expect(plan.slots.map((slot) => slot.redact)).toEqual([true, false]);
  });

  test("updateAll returning whole rows stamps them with the target's schema", () => {
    const ast = rebuild(from(Post, "p").ast, {
      updates: [{ kind: "update", field: "views", column: "views", value: literalNode(0) }],
      select: { kind: "select", shape: { kind: "binding", binding: "p", meta: meta(Post) }, constants: [] },
    });
    const plan = createCompiler(postgresDialect).compile(ast, "updateAll", "tenant_1");
    expect(plan.schema).toBe("tenant_1");
    expect((plan.output as Extract<OutputPlan, { kind: "row" }>).schema).toBe("tenant_1");
  });
});

describe("row-level write errors", () => {
  const compiler = createCompiler(postgresDialect);

  test("a field of another schema is refused, even where its position would find a cached plan", () => {
    compiler.compileUpdate(users, [email], [id], [], undefined);
    const postTitle = field(meta(Post), "title");
    expect(() => compiler.compileUpdate(users, [postTitle], [id], [], undefined)).toThrow(
      "The update's set list holds a field that is not a field of User.",
    );
    expect(() => compiler.compileInsert(users, [postTitle], one(), undefined)).toThrow(
      "The insert's column list holds a field that is not a field of User.",
    );
    expect(() => compiler.compileDelete(users, [postTitle], [], undefined)).toThrow(
      "The delete's where list holds a field that is not a field of User.",
    );
    expect(() => compiler.compileDelete(users, [id], [postTitle], undefined)).toThrow(
      "The returning list holds a field that is not a field of User.",
    );
  });

  test("a virtual field is refused", () => {
    expect(() => compiler.compileInsert(users, [field(users, "password")], one(), undefined)).toThrow(
      "The insert's column list holds the virtual field User.password, which has no column.",
    );
  });

  test("an embedded schema has no table", () => {
    const settings = meta(UserSettings);
    expect(() => compiler.compileInsert(settings, [field(settings, "theme")], one(), undefined)).toThrow(
      "UserSettings is an embedded schema: it has no table to write to.",
    );
  });

  test("an update needs fields to set and to find the row by; a delete needs the latter", () => {
    expect(() => compiler.compileUpdate(users, [], [id], [], undefined)).toThrow(
      "A row update needs at least one field to set.",
    );
    expect(() => compiler.compileUpdate(users, [name], [], [], undefined)).toThrow(
      "A row update needs at least one field to find the row by.",
    );
    expect(() => compiler.compileDelete(users, [], [], undefined)).toThrow(
      "A row delete needs at least one field to find the row by.",
    );
  });

  test("an insert's row count must be a whole number of at least one", () => {
    for (const rows of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        compiler.compileInsert(
          users,
          [email],
          { source: { kind: "values", rows }, returning: [], onConflict: undefined },
          undefined,
        ),
      ).toThrow("An insert of values needs a whole number of rows, at least one.");
    }
  });

  test("an insert's source must be values, cells or a query", () => {
    expect(() =>
      compiler.compileInsert(
        users,
        [email],
        { source: { kind: "csv" } as never, returning: [], onConflict: undefined },
        undefined,
      ),
    ).toThrow("An insert's source is values, cells or a query.");
  });

  test("cells need columns, rows, and one cell per column", () => {
    const cells = (rows: unknown, columns: readonly FieldMeta[] = [email]) =>
      compiler.compileInsert(
        users,
        columns,
        { source: { kind: "cells", rows: rows as never }, returning: [], onConflict: undefined },
        undefined,
      );
    expect(() => cells([[{ kind: "value" }]], [])).toThrow("An insert of cells needs a column list.");
    expect(() => cells([])).toThrow("An insert of cells needs at least one row.");
    expect(() => cells("x")).toThrow("An insert of cells needs at least one row.");
    expect(() => cells([[{ kind: "value" }, { kind: "value" }]])).toThrow(
      "Row 0 of the insert has 2 cells for 1 columns.",
    );
    expect(() => cells([[{ kind: "spreadsheet" }]])).toThrow('Unknown insert cell kind "spreadsheet".');
  });

  test("an insert from a query needs a column list", () => {
    expect(() =>
      compiler.compileInsert(
        users,
        [],
        { source: { kind: "query", query: from(User, "u").ast }, returning: [], onConflict: undefined },
        undefined,
      ),
    ).toThrow("An insert from a query needs a column list.");
  });

  test("several rows of defaults need a column; a schema without one cannot have them", () => {
    const noColumns = { ...tags, persisted: [] } as SchemaMeta;
    expect(() =>
      createCompiler(postgresDialect).compileInsert(
        noColumns,
        [],
        { source: { kind: "values", rows: 2 }, returning: [], onConflict: undefined },
        undefined,
      ),
    ).toThrow("Tag has no column to insert defaults into.");
  });

  test("onConflict errors", () => {
    const upsert = (onConflict: unknown) =>
      compiler.compileInsert(
        users,
        [email, name],
        { source: { kind: "values", rows: 1 }, returning: [], onConflict: onConflict as never },
        undefined,
      );
    expect(() => upsert("sometimes")).toThrow('onConflict is "nothing" or { target, update }.');
    expect(() => upsert({ target: undefined, update: "all" })).toThrow(
      "onConflict with update needs a target on postgres: the conflicting fields, { constraint } or a fragment.",
    );
    expect(() => upsert({ target: [], update: "all" })).toThrow("onConflict's target lists no field.");
    expect(() => upsert({ target: { constraint: "" }, update: "all" })).toThrow(
      "onConflict's target is a list of fields, { constraint: name } or a fragment.",
    );
    expect(() => upsert({ target: [email], update: "some" })).toThrow(
      'onConflict\'s update is "all", a list of fields or { except }.',
    );
    expect(() => upsert({ target: [email], update: { except: [email, name] } })).toThrow(
      'onConflict\'s update leaves no column to update; use onConflict: "nothing" instead.',
    );
    expect(() => upsert({ target: [field(meta(Post), "title")], update: "all" })).toThrow(
      "onConflict's target holds a field that is not a field of User.",
    );
    expect(() => upsert({ target: [email], update: [field(meta(Post), "title")] })).toThrow(
      "onConflict's update list holds a field that is not a field of User.",
    );
    expect(() => upsert({ target: [email], update: { except: [field(meta(Post), "title")] } })).toThrow(
      "onConflict's except list holds a field that is not a field of User.",
    );
  });

  test("onConflict update except keeps the other inserted columns", () => {
    const plan = compiler.compileInsert(
      users,
      [email, name, lockVersion],
      {
        source: { kind: "values", rows: 1 },
        returning: [],
        onConflict: { target: [email], update: { except: [email] } },
      },
      undefined,
    );
    expect(plan.sql).toBe(
      'insert into "users" ("email", "name", "lock_version") values ($1, $2, $3) on conflict ("email") do update set "name" = "excluded"."name", "lock_version" = "excluded"."lock_version"',
    );
  });

  test("a fragment conflict target binds its values after the rows'", () => {
    const plan = compiler.compileInsert(
      tags,
      [field(tags, "name")],
      {
        source: { kind: "values", rows: 2 },
        returning: [],
        onConflict: { target: frag`(name) where name <> ${value("x")}`, update: "all" },
      },
      undefined,
    );
    expect(plan.sql).toBe(
      'insert into "tags" ("name") values ($1), ($2) on conflict (name) where name <> $3 do update set "name" = "excluded"."name"',
    );
    expect(plan.slots.map((slot) => (slot.kind === "inline" ? slot.index : -1))).toEqual([0, 1, 2]);
  });
});

describe("bulk update and delete errors", () => {
  const compile = (
    ast: Parameters<ReturnType<typeof createCompiler>["compile"]>[0],
    operation: "updateAll" | "deleteAll",
  ) => createCompiler(postgresDialect).compile(ast, operation, undefined);
  const set = [{ kind: "update" as const, field: "views", column: "views", value: literalNode(0) }];
  const posts = from(Post, "p");

  test.each([
    ["distinct()", posts.distinct().ast],
    ["groupBy()", posts.groupBy(({ p }) => p.authorId).ast],
    ["having()", rebuild(posts.ast, { havings: [{ kind: "bool", op: "and", expr: literalNode(true) }] })],
    ["orderBy()", posts.orderBy(({ p }) => p.id).ast],
    ["limit()", posts.limit(1).ast],
    ["offset()", posts.offset(1).ast],
    ["lock()", posts.lock("update").ast],
  ])("updateAll refuses a query with %s", (clause, ast) => {
    expect(() => compile(rebuild(ast, { updates: set }), "updateAll")).toThrow(
      `updateAll cannot run a query with ${clause}.`,
    );
  });

  test("other clauses that have no meaning in a bulk write are refused", () => {
    const base = rebuild(posts.ast, { updates: set });
    expect(() =>
      compile(
        rebuild(base, { combinations: [{ kind: "combination", op: "union", all: false, query: posts.ast }] }),
        "updateAll",
      ),
    ).toThrow("updateAll cannot run a query with a set operation.");
    expect(() =>
      compile(
        rebuild(base, {
          windows: [
            {
              kind: "windowDef",
              name: "w",
              spec: { kind: "window", partitionBy: [], orderBy: [], frame: undefined },
            },
          ],
        }),
        "updateAll",
      ),
    ).toThrow("updateAll cannot run a query with windows.");
    expect(() => compile(rebuild(base, { hints: [frag`tablesample system (1)`] }), "updateAll")).toThrow(
      "updateAll cannot run a query with table hints.",
    );
    expect(() =>
      compile(rebuild(base, { from: { kind: "subquerySource", query: posts.ast, alias: "p" } }), "updateAll"),
    ).toThrow("updateAll cannot run a query with a root that is not a table.");
  });

  test("updateAll needs assignments and deleteAll takes none", () => {
    expect(() => compile(posts.ast, "updateAll")).toThrow("updateAll needs set(…) assignments.");
    expect(() => compile(rebuild(posts.ast, { updates: set }), "deleteAll")).toThrow(
      "deleteAll cannot run a query with set(…) assignments.",
    );
  });

  test("a query with assignments cannot run as a select", () => {
    expect(() =>
      createCompiler(postgresDialect).compile(rebuild(posts.ast, { updates: set }), "all", undefined),
    ).toThrow("The query has set(…) assignments; run it with updateAll.");
  });

  test("a bulk write joins only with inner and cross joins", () => {
    const ast = rebuild(posts.leftJoin(User, "u", ({ p, u }) => u.id.eq(p.authorId)).ast, { updates: set });
    expect(() => compile(ast, "updateAll")).toThrow(
      "updateAll can join only with join() or crossJoin(); a left join has no meaning there.",
    );
  });

  test("a cross join in a bulk delete adds a source and no condition", () => {
    const ast = rebuild(posts.ast, {
      joins: [{ kind: "join", type: "cross", source: tableOf(User, "u"), on: undefined }],
      wheres: [{ kind: "bool", op: "and", expr: binaryNode("eq", col("u", "id"), col("p", "author_id")) }],
    });
    expect(compile(ast, "deleteAll").sql).toBe(
      'delete from "posts" as "p" using "users" as "u" where "u"."id" = "p"."author_id"',
    );
  });

  test("a bulk write's condition is grouped, since join conditions may be added to it", () => {
    const ast = rebuild(posts.where(({ p }) => p.views.gt(1)).orWhere(({ p }) => p.views.isNull()).ast, {
      updates: [{ kind: "update", field: "views", column: "views", value: value(0, typeOf(t.integer())) }],
    });
    expect(compile(ast, "updateAll").sql).toBe(
      'update "posts" as "p" set "views" = $1 where ("p"."views" > $2 or "p"."views" is null)',
    );
  });

  test("an unknown operation is refused", () => {
    expect(() => createCompiler(postgresDialect).compile(posts.ast, "upsertAll" as never, undefined)).toThrow(
      'Unknown query operation "upsertAll".',
    );
  });
});

describe("explain", () => {
  test("options are validated", () => {
    const compiler = createCompiler(postgresDialect);
    const ast = from(User, "u").ast;
    expect(() => compiler.compileExplain(ast, "all", undefined, { analyze: "yes" as never })).toThrow(
      "explain's analyze option is true or false.",
    );
    expect(() => compiler.compileExplain(ast, "all", undefined, { format: "yaml" as never })).toThrow(
      'explain\'s format option is "text" or "json".',
    );
    expect(
      compiler
        .compileExplain(ast, "all", undefined, { format: "text" })
        .sql.startsWith("explain (format text) select"),
    ).toBe(true);
  });

  test("an option the dialect lacks is refused", () => {
    const plain: SqlDialect = {
      ...postgresDialect,
      name: "sqlite",
      explainOptions: { analyze: false, format: false },
    };
    const compiler = createCompiler(plain);
    const ast = from(User, "u").ast;
    expect(() => compiler.compileExplain(ast, "all", undefined, { analyze: true })).toThrow(
      "explain's analyze option is not supported by sqlite.",
    );
    expect(() => compiler.compileExplain(ast, "all", undefined, { format: "json" })).toThrow(
      "explain's format option is not supported by sqlite.",
    );
  });

  test("an explain plan has the query's slots and no output", () => {
    const compiler = createCompiler(postgresDialect);
    const ast = from(User, "u").where(({ u }) => u.id.eq(1)).ast;
    const plan = compiler.compileExplain(ast, "all", undefined, {});
    expect(plan.slots).toBe(compiler.compile(ast, "all", undefined).slots);
    expect(plan.output).toBeUndefined();
  });
});

describe("fragments as statements", () => {
  test("a fragment cannot refer to a binding", () => {
    expect(() => createCompiler(postgresDialect).compileFragment(frag`select ${col("u", "id")}`)).toThrow(
      'The column u.id refers to the binding "u", which the query does not have.',
    );
  });

  test("only a fragment is accepted", () => {
    expect(() => createCompiler(postgresDialect).compileFragment(selectOne(literalNode(1)) as never)).toThrow(
      "compileFragment() takes a fragment: fragment`select …`.",
    );
  });
});
