// Type tests for arithmetic of mixed numeric types: the static type agrees with the type
// the result is read as (the wider operand's). Numbers mix with numbers only, so every
// mix of integer, float and bigint({ mode: "number" }) is a number; a bigint-mode bigint
// mixes with bigints only.
import type { Post } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { Row } from "../contracts/schema.js";
import { t } from "../schema/index.js";
import type { Col, ValueOf } from "./expr.js";
import { val } from "./functions.js";

declare const views: Col<Row<typeof Post>["views"]>;
declare const authorId: Col<Row<typeof Post>["authorId"]>;

describe("arithmetic of mixed numeric types", () => {
  test("an integer column beside a float value is a number, read as a float", () => {
    const half = views.div(val(2, t.float()));
    expectTypeOf<ValueOf<typeof half>>().toEqualTypeOf<number | null>();
    expectTypeOf(half).not.toBeAny();
    const share = val(6, t.float()).div(views);
    expectTypeOf<ValueOf<typeof share>>().toEqualTypeOf<number | null>();
  });

  test("integer beside bigint({ mode: 'number' }) is a number, read as that bigint", () => {
    const wide = views.add(val(1, t.bigint({ mode: "number" })));
    expectTypeOf<ValueOf<typeof wide>>().toEqualTypeOf<number | null>();
    const columns = authorId.div(val(2, t.float()));
    expectTypeOf<ValueOf<typeof columns>>().toEqualTypeOf<number>();
    const both = views.add(authorId);
    expectTypeOf<ValueOf<typeof both>>().toEqualTypeOf<number | null>();
  });

  test("a bigint-mode bigint mixes with bigints only", () => {
    const sum = val(1n, t.bigint()).add(val(2n, t.bigint()));
    expectTypeOf<ValueOf<typeof sum>>().toEqualTypeOf<bigint>();
    // @ts-expect-error a number column beside a bigint value
    views.add(val(1n, t.bigint()));
    // @ts-expect-error a bigint value beside a number column
    val(1n, t.bigint()).add(views);
  });
});
