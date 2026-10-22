import { type Membership, type Org, Post, User } from "@egon-orm/test-support";
import type { Changeset, FieldValues, InsertShape, Row, RowSchema, StandardSchemaV1 } from "egon-orm";
import { cast, Schema, t } from "egon-orm";
import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { castWith, toZod, VERSION } from "./index.js";

declare const params: unknown;
declare const userOrClass: User | typeof User;
declare const user: User;

/** A schema class without getters or methods: its row type is exactly its fields. */
class Account extends Schema("accounts", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  nickname: t.string().nullable(),
  plan: t.enum(["free", "pro"]).default("free"),
  balance: t.bigint(),
  tags: t.array(t.string()),
  secret: t.string().virtual(),
  token: t.string().nullable().redact(),
  openedAt: t.timestamp(),
}) {}

test("VERSION is a string, not any", () => {
  expectTypeOf(VERSION).toBeString();
  expectTypeOf(VERSION).not.toBeAny();
});

describe("a Zod schema is a Standard Schema", () => {
  test("assignable to the vendored StandardSchemaV1", () => {
    const schema = z.object({ email: z.string() });
    expectTypeOf(schema).toExtend<StandardSchemaV1>();
    expectTypeOf(schema).toExtend<StandardSchemaV1<{ email: string }, { email: string }>>();
    const asStandard: StandardSchemaV1 = z.string().email();
    void asStandard;
  });

  test("accepted by validate and validateField", () => {
    const cs = cast(User, params, ["email", "age"]);
    expectTypeOf(cs.validate(z.object({ email: z.string().email() }))).toEqualTypeOf<typeof cs>();
    expectTypeOf(cs.validateField("email", z.string().email())).toEqualTypeOf<typeof cs>();
  });
});

describe("toZod: row mode", () => {
  test("infers the fields of Row<S> for a schema class without getters or methods", () => {
    type Inferred = z.infer<ReturnType<typeof toZod<typeof Account>>>;
    // Row<S> also carries a type-only marker ("~fields"), which a parsed object does not have.
    expectTypeOf<Inferred>().toEqualTypeOf<Omit<Row<typeof Account>, "~fields">>();
    expectTypeOf<Inferred>().toEqualTypeOf<FieldValues<typeof Account>>();
    expectTypeOf<Inferred>().not.toBeAny();
  });

  test("infers the fields of the row (getters left out) for a class with a getter", () => {
    const UserZ = toZod(User);
    type Inferred = z.infer<typeof UserZ>;
    expectTypeOf<Inferred>().toEqualTypeOf<FieldValues<typeof User>>();
    expectTypeOf<Row<typeof User>>().toExtend<Inferred>();
  });

  test("covers every blog schema", () => {
    expectTypeOf<z.infer<ReturnType<typeof toZod<typeof Post>>>>().toEqualTypeOf<FieldValues<typeof Post>>();
    expectTypeOf<z.infer<ReturnType<typeof toZod<typeof Org>>>>().toEqualTypeOf<FieldValues<typeof Org>>();
    expectTypeOf<z.infer<ReturnType<typeof toZod<typeof Membership>>>>().toEqualTypeOf<
      FieldValues<typeof Membership>
    >();
  });
});

describe("toZod: insert mode", () => {
  test("infers InsertShape<S>", () => {
    const AccountInsert = toZod(Account, { mode: "insert" });
    expectTypeOf<z.infer<typeof AccountInsert>>().toEqualTypeOf<InsertShape<typeof Account>>();
    const UserInsert = toZod(User, { mode: "insert" });
    expectTypeOf<z.infer<typeof UserInsert>>().toEqualTypeOf<InsertShape<typeof User>>();
    const PostInsert = toZod(Post, { mode: "insert" });
    expectTypeOf<z.infer<typeof PostInsert>>().toEqualTypeOf<InsertShape<typeof Post>>();
  });

  test("the guide's example: pick, then extend", () => {
    const CreateUser = toZod(User, { mode: "insert", pick: ["email", "name", "age"] }).extend({
      email: z.string().email(),
    });
    type CreateUser = z.infer<typeof CreateUser>;
    expectTypeOf<CreateUser>().toEqualTypeOf<{ email: string; name?: string | null; age?: number | null }>();
  });

  test("virtual fields cannot be picked", () => {
    // @ts-expect-error password is virtual, so not part of an insert
    toZod(User, { mode: "insert", pick: ["password"] });
  });
});

describe("toZod: update mode", () => {
  test("infers every field optional", () => {
    const AccountUpdate = toZod(Account, { mode: "update" });
    expectTypeOf<z.infer<typeof AccountUpdate>>().toEqualTypeOf<Partial<FieldValues<typeof Account>>>();
  });
});

describe("toZod: pick and omit", () => {
  test("pick keeps the named fields", () => {
    const Picked = toZod(Account, { pick: ["email", "nickname"] });
    expectTypeOf<z.infer<typeof Picked>>().toEqualTypeOf<{ email: string; nickname: string | null }>();
  });

  test("omit leaves the named fields out", () => {
    const Omitted = toZod(Account, { mode: "update", omit: ["id", "secret", "token", "openedAt", "tags"] });
    expectTypeOf<z.infer<typeof Omitted>>().toEqualTypeOf<{
      email?: string;
      nickname?: string | null;
      plan?: "free" | "pro";
      balance?: bigint;
    }>();
  });

  test("names are checked", () => {
    // @ts-expect-error not a field
    toZod(Account, { pick: ["emial"] });
    // @ts-expect-error not a field
    toZod(Account, { omit: ["emial"] });
    // @ts-expect-error not a mode
    toZod(Account, { mode: "patch" });
  });
});

describe("castWith", () => {
  test("returns the changeset type cast would", () => {
    const Signup = toZod(User, { mode: "insert", pick: ["email", "name"] });
    expectTypeOf(castWith(User, params, Signup)).toEqualTypeOf<Changeset<typeof User, true>>();
    expectTypeOf(castWith(userOrClass, params, Signup)).toEqualTypeOf<Changeset<typeof User, boolean>>();
    expectTypeOf(castWith(user, params, toZod(User, { pick: ["name"] }))).toEqualTypeOf<
      Changeset<RowSchema<User>, false>
    >();
    const existing = cast(User, params, ["email"]);
    expectTypeOf(castWith(existing, params, Signup)).toEqualTypeOf<typeof existing>();
  });

  test("refuses a schema with a key that is not a field", () => {
    // @ts-expect-error termsOfService is not a field of User
    castWith(User, params, z.object({ email: z.string(), termsOfService: z.boolean() }));
  });
});
