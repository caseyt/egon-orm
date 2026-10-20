// The type an arithmetic result is read as when its operands have different numeric types:
// the wider one (integer < bigint < decimal < float), and the left operand's otherwise.
import { Post } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { createCompiler } from "../compiler/compiler.js";
import { postgresDialect } from "../compiler/dialect.js";
import type { OutputPlan } from "../contracts/adapter.js";
import type { AnyFieldType } from "../contracts/type.js";
import { defineType, from, t, val } from "../index.js";
import { numericRank, widerType } from "./widen.js";

/** The field type a typed value carries. */
const typeOfValue = (expr: { readonly type: AnyFieldType | undefined }): AnyFieldType => {
  if (expr.type === undefined) throw new Error("untyped");
  return expr.type;
};
const integer = typeOfValue(val(1, t.integer()));
const bigintNumber = typeOfValue(val(1, t.bigint({ mode: "number" })));
const float = typeOfValue(val(1, t.float()));
const decimal = typeOfValue(val("1", t.decimal()));

/** The type each value leaf of a compiled select is read with, by key or alone. */
function leafTypes(output: OutputPlan | undefined): unknown {
  if (output?.kind === "value") return output.type?.db.kind;
  if (output?.kind === "object") {
    return Object.fromEntries(output.keys.map((key, i) => [key, leafTypes(output.values[i])]));
  }
  throw new Error(`unexpected output ${String(output?.kind)}`);
}
const cents = defineType<number>({
  name: "cents",
  db: { kind: "custom", sql: "numeric(10, 2)" },
  cast: (v) => ({ success: true, data: Number(v) }),
});

describe("numericRank", () => {
  test("orders integer < bigint < decimal < float; other kinds have no place", () => {
    expect([integer, bigintNumber, decimal, float].map((each) => numericRank(each.db))).toEqual([0, 1, 2, 3]);
    expect(numericRank({ kind: "text" })).toBeUndefined();
    expect(numericRank({ kind: "custom", sql: "money" })).toBeUndefined();
    expect(numericRank({ kind: "constructor" as never })).toBeUndefined();
    expect(numericRank(undefined)).toBeUndefined();
    expect(numericRank(null as never)).toBeUndefined();
  });
});

describe("widerType", () => {
  test("is the wider of two numeric types, in either order", () => {
    expect(widerType(integer, float)).toBe(float);
    expect(widerType(float, integer)).toBe(float);
    expect(widerType(integer, bigintNumber)).toBe(bigintNumber);
    expect(widerType(bigintNumber, decimal)).toBe(decimal);
  });

  test("keeps the left type for equal places, a custom type or a missing one", () => {
    const otherInteger = typeOfValue(val(1, t.integer()));
    expect(widerType(integer, otherInteger)).toBe(integer);
    expect(widerType(integer, cents)).toBe(integer);
    expect(widerType(cents, float)).toBe(cents);
    expect(widerType(integer, undefined)).toBe(integer);
    expect(widerType(undefined, float)).toBeUndefined();
  });
});

describe("arithmetic results are read as the wider operand's type", () => {
  test("a column beside a typed value or another column, on either side", () => {
    const q = from(Post, "p").select(({ p }) => ({
      half: p.views.div(val(2, t.float())),
      share: val(6, t.float()).div(p.views),
      wide: p.views.add(val(1, t.bigint({ mode: "number" }))),
      columns: p.views.add(p.authorId),
      key: p.authorId.add(val(1, t.integer())),
      plain: p.views.add(1),
      custom: p.views.div(val(2, t.type(cents))),
      remainder: p.views.mod(val(2, t.float())),
    }));
    const plan = createCompiler(postgresDialect).compile(q.ast, "all", undefined);
    expect(leafTypes(plan.output)).toEqual({
      half: "float",
      share: "float",
      wide: "bigint",
      columns: "bigint",
      key: "bigint",
      plain: "integer",
      custom: "integer",
      remainder: "integer",
    });
  });

  test("the widened type keeps the bigint operand's mode", () => {
    const q = from(Post, "p").select(({ p }) => p.views.add(p.authorId));
    const plan = createCompiler(postgresDialect).compile(q.ast, "all", undefined);
    expect(plan.output?.kind === "value" && plan.output.type?.fromDb("8")).toBe(8);
  });

  test("a plain value takes the left side's type, and so does the result", () => {
    const half = from(Post, "p").select(({ p }) => p.views.div(val(2, t.float())).add(0.5));
    const plan = createCompiler(postgresDialect).compile(half.ast, "all", undefined);
    expect(plan.sql).toBe(
      'select "p"."views" / cast($1 as double precision) + cast($2 as double precision) as "c0" from "posts" as "p"',
    );
    expect(leafTypes(plan.output)).toBe("float");
  });
});
