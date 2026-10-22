// JsonReturn of functions with declared return types, as the first and only content of
// the file: nothing earlier in the file warms TypeScript's instantiation caches, so this
// is what a handler module sees. It must not hit "Type instantiation is excessively deep".
import type { Comment, User } from "@egon-orm/test-support";
import { expectTypeOf, test } from "vitest";
import type { Loaded } from "./contracts/schema.js";
import type { Json, JsonReturn } from "./schema/json-types.js";

export declare function me(): Promise<User>;
export declare function comment(): Promise<Loaded<typeof Comment, "post">>;
export type Me = JsonReturn<typeof me>;
export type CommentResponse = JsonReturn<typeof comment>;

test("JsonReturn of handlers with declared return types, cold", () => {
  expectTypeOf<Me>().toEqualTypeOf<Json<User>>();
  expectTypeOf<CommentResponse["post"]["title"]>().toEqualTypeOf<string>();
});
