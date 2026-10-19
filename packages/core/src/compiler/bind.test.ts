import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ParamSlot } from "../contracts/adapter.js";
import { from, param, t } from "../index.js";
import { bindParams, toSql } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";

const double = (value: unknown) => (value as number) * 2;

describe("bindParams", () => {
  test("each slot takes its value from params or from the named values, in slot order", () => {
    const slots: ParamSlot[] = [
      { kind: "named", name: "b", toDb: undefined, redact: false },
      { kind: "inline", index: 1, toDb: undefined, redact: false },
      { kind: "list", index: 0, toDb: undefined, redact: false },
      { kind: "element", index: 0, element: 1, toDb: undefined, redact: false },
    ];
    expect(bindParams(slots, [[10, 20], "x"], { b: true })).toEqual([true, "x", [10, 20], 20]);
  });

  test("toDb converts every value but null, and every element of a list", () => {
    const slots: ParamSlot[] = [
      { kind: "inline", index: 0, toDb: double, redact: false },
      { kind: "inline", index: 1, toDb: double, redact: false },
      { kind: "list", index: 2, toDb: double, redact: false },
      { kind: "element", index: 2, element: 0, toDb: double, redact: false },
      { kind: "named", name: "n", toDb: double, redact: false },
    ];
    expect(bindParams(slots, [3, null, [1, null, 4]], { n: 5 })).toEqual([6, null, [2, null, 8], 2, 10]);
  });

  test("a list that is not an array is passed as it is", () => {
    const slots: ParamSlot[] = [{ kind: "list", index: 0, toDb: double, redact: false }];
    expect(bindParams(slots, [null])).toEqual([null]);
  });

  test("a named value may be null", () => {
    const slots: ParamSlot[] = [{ kind: "named", name: "n", toDb: double, redact: false }];
    expect(bindParams(slots, [], { n: null })).toEqual([null]);
  });

  test("a missing named value throws, listing each name once", () => {
    const slots: ParamSlot[] = [
      { kind: "named", name: "minAge", toDb: undefined, redact: false },
      { kind: "named", name: "minAge", toDb: undefined, redact: false },
      { kind: "named", name: "role", toDb: undefined, redact: false },
    ];
    expect(() => bindParams(slots, [])).toThrow(
      'The query needs the named parameters "minAge", "role", which were not given a value.',
    );
    expect(() => bindParams(slots, [], { role: "admin", minAge: undefined })).toThrow(
      'The query needs the named parameter "minAge", which was not given a value.',
    );
  });

  test("an inherited property is not a named value", () => {
    const slots: ParamSlot[] = [{ kind: "named", name: "toString", toDb: undefined, redact: false }];
    expect(() => bindParams(slots, [], {})).toThrow('needs the named parameter "toString"');
  });

  test("a named value the query does not use throws", () => {
    const slots: ParamSlot[] = [{ kind: "named", name: "minAge", toDb: undefined, redact: false }];
    expect(() => bindParams(slots, [], { minAge: 1, maxAge: 2, extra: 3 })).toThrow(
      'The query has no named parameters "maxAge", "extra"; it takes "minAge".',
    );
    expect(() => bindParams([], [], { minAge: 1 })).toThrow(
      'The query has no named parameter "minAge"; it takes none.',
    );
  });

  test("a compiled query binds named and positional values together", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(param("minAge", t.integer())))
      .where(({ u }) => u.role.eq("admin"))
      .limit(10);
    const plan = createCompiler(postgresDialect).compile(q.ast, "all", undefined);
    expect(toSql(plan, q.ast.params, { minAge: 18 })).toEqual({
      sql: 'select "u"."id" as "c0", "u"."email" as "c1", "u"."name" as "c2", "u"."age" as "c3", "u"."role" as "c4", "u"."password_hash" as "c5", "u"."settings" as "c6", "u"."lock_version" as "c7", "u"."created_at" as "c8", "u"."updated_at" as "c9" from "users" as "u" where "u"."age" >= $1 and "u"."role" = $2 limit $3',
      params: [18, "admin", 10],
    });
  });
});
