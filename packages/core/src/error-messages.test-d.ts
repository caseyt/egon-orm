// Type tests of the error tree: errorMessages() and traverseErrors() typed by the schema.
import { Comment, Post, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import { createBatch } from "./batch/index.js";
import { type Changeset, cast, change, traverseErrors } from "./changeset/changeset.js";
import type { ErrorMessagesOf, ErrorTree, TypedErrorTree } from "./changeset/types.js";
import type { Repo } from "./repo/repo.js";
import { hasMany, Schema, t } from "./schema/index.js";

declare const repo: Repo;
declare const params: Record<string, unknown>;
declare const post: Post;
declare const account: Account;

class Account extends Schema("accounts", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  password: t.string().virtual(),
}) {
  static notes = hasMany(() => Note, { foreignKey: "accountId" });

  static changeset(account: Account | typeof Account, input: unknown) {
    return cast(account, input, ["email", "password"])
      .validateRequired(["email"])
      .validateConfirmation("password")
      .validateAcceptance("terms");
  }
}

class Note extends Schema("notes", {
  id: t.integer().primaryKey().dbGenerated(),
  accountId: t.integer(),
  body: t.string(),
}) {}

describe("errorMessages()", () => {
  test("is keyed by field, association and $base", () => {
    const tree = cast(Post, params, ["title"]).errorMessages();
    expectTypeOf(tree.title).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(tree.$base).toEqualTypeOf<string[] | undefined>();
    expectTypeOf<keyof typeof tree>().toEqualTypeOf<
      | "id"
      | "authorId"
      | "title"
      | "body"
      | "published"
      | "views"
      | "tagList"
      | "publishedAt"
      | "createdAt"
      | "updatedAt"
      | "author"
      | "comments"
      | "tags"
      | "$base"
    >();
    // @ts-expect-error a typo is a compile error
    tree.titel;
  });

  test("nested trees: an object for a to-one association or embed, a list for a to-many one", () => {
    const tree = cast(Account, params, ["email"])
      .castAssoc("notes", { with: (note, input) => cast(note, input, ["body"]) })
      .errorMessages();
    type Notes = NonNullable<(typeof tree)["notes"]>;
    expectTypeOf<Notes>().toEqualTypeOf<
      | string[]
      | ErrorMessagesOf<typeof Note>[]
      | { $errors: string[]; $items: ErrorMessagesOf<typeof Note>[] }
    >();
    const notes = tree.notes;
    if (notes !== undefined && !Array.isArray(notes)) {
      expectTypeOf(notes.$errors).toEqualTypeOf<string[]>();
      expectTypeOf(notes.$items[0]?.body).toEqualTypeOf<string[] | undefined>();
    }
    const userTree = cast(User, params, ["email"]).errorMessages();
    const settings = userTree.settings;
    if (settings !== undefined && !Array.isArray(settings)) {
      expectTypeOf(settings.theme).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(settings.$errors).toEqualTypeOf<string[] | undefined>();
      // @ts-expect-error not a field of the embedded schema
      settings.colour;
    }
    const author = cast(Comment, params, ["body"]).errorMessages().author;
    if (author !== undefined && !Array.isArray(author)) {
      expectTypeOf(author.email).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(author).not.toBeAny();
    }
  });

  test("collects the keys validations add", () => {
    const tree = cast(User, params, ["email", "password"])
      .validateConfirmation("password")
      .addError("captcha", "is wrong")
      .validateAcceptance("termsOfService")
      .errorMessages();
    expectTypeOf(tree.passwordConfirmation).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(tree.captcha).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(tree.termsOfService).toEqualTypeOf<string[] | undefined>();
    const plain = cast(User, params, ["email"]).errorMessages();
    // @ts-expect-error no validation added this key
    plain.passwordConfirmation;
  });

  test("field names still autocomplete in addError and validateAcceptance", () => {
    const cs = cast(User, params, ["email"]).addError("email", "is taken");
    expectTypeOf(cs.errorMessages().email).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(cs).toEqualTypeOf<Changeset<typeof User, true>>();
  });

  test("the extra keys flow through a write: the error changeset is the one given", async () => {
    const inserted = await repo.insert(Account.changeset(Account, params));
    if (!inserted.success) {
      const tree = inserted.error.errorMessages();
      expectTypeOf(tree.passwordConfirmation).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(tree.terms).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(tree.notes).not.toBeAny();
      expectTypeOf(inserted.error).toEqualTypeOf<ReturnType<typeof Account.changeset>>();
    }
    const updated = await repo.update(cast(account, params, ["email"]).addError("captcha", "is wrong"));
    if (!updated.success)
      expectTypeOf(updated.error.errorMessages().captcha).toEqualTypeOf<string[] | undefined>();
    const upserted = await repo.insertOrUpdate(Account.changeset(account, params));
    if (!upserted.success) {
      expectTypeOf(upserted.error.errorMessages().passwordConfirmation).toEqualTypeOf<string[] | undefined>();
    }
  });

  test("only the changeset that adds a key has it: another changeset of the schema does not", async () => {
    const login = cast(Account, params, ["email"]);
    // @ts-expect-error nothing added passwordConfirmation to this changeset
    login.errorMessages().passwordConfirmation;
    const result = await repo.insert(login);
    // @ts-expect-error nor to the one the write gives back
    if (!result.success) result.error.errorMessages().passwordConfirmation;
    // @ts-expect-error a schema class has its fields, associations and $base only
    type _FromClass = ErrorMessagesOf<typeof Account>["passwordConfirmation"];
  });

  test("the extra keys flow through a batch's failure", async () => {
    const batch = createBatch().insert("account", Account.changeset(Account, params));
    const outcome = await repo.transaction(batch);
    if (!outcome.success && outcome.error.step === "account") {
      expectTypeOf(outcome.error.error.errorMessages().passwordConfirmation).toEqualTypeOf<
        string[] | undefined
      >();
    }
  });

  test("a changeset with extra keys is still a changeset of its schema", async () => {
    const cs = cast(User, params, ["email"]).addError("captcha", "is wrong");
    await repo.insert(cs);
    const loaded = change(post).addError("$base", "is locked");
    await repo.update(loaded);
  });

  test("ErrorMessagesOf takes a changeset type or a schema class", () => {
    const cs = cast(User, params, ["email", "password"]).validateConfirmation("password");
    expectTypeOf<ErrorMessagesOf<typeof cs>>().toEqualTypeOf(cs.errorMessages());
    expectTypeOf<ErrorMessagesOf<typeof cs>>().toEqualTypeOf<
      TypedErrorTree<typeof User, "passwordConfirmation", string>
    >();
    expectTypeOf<ErrorMessagesOf<typeof User>>().toEqualTypeOf<TypedErrorTree<typeof User, never, string>>();
    const clientSide: ErrorMessagesOf<typeof User> = { email: ["has already been taken"] };
    expectTypeOf(clientSide).not.toBeAny();
    // @ts-expect-error a typo is a compile error
    const typo: ErrorMessagesOf<typeof User> = { emial: ["x"] };
    expectTypeOf(typo).not.toBeAny();
  });

  test("a changeset made from a row alone knows its fields, and takes any other key", () => {
    const tree = change(post).errorMessages();
    expectTypeOf(tree.title).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(tree.anything).toEqualTypeOf<
      readonly string[] | ErrorTree<string> | readonly ErrorTree<string>[] | undefined
    >();
  });

  test("a schemaless changeset is keyed by its fields", () => {
    const tree = cast({ data: {}, types: { q: t.string(), page: t.integer() } }, params, [
      "q",
      "page",
    ]).errorMessages();
    expectTypeOf<keyof typeof tree>().toEqualTypeOf<"q" | "page" | "$base">();
  });
});

describe("traverseErrors", () => {
  test("is typed like errorMessages(), with the callback's values", () => {
    const cs = cast(Post, params, ["title"]);
    const tree = traverseErrors(cs, (error) => error.message.length);
    expectTypeOf(tree.title).toEqualTypeOf<number[] | undefined>();
    // @ts-expect-error a typo is a compile error
    tree.titel;
  });
});
