// Type tests of the error tree: errorMessages() and traverseErrors() typed by the schema.
import { Comment, Post, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import { type Changeset, cast, change, traverseErrors } from "./changeset/changeset.js";
import type { ErrorMessages, ErrorTree, ExtraErrorKeys, TypedErrorTree } from "./changeset/types.js";
import type { Repo } from "./repo/repo.js";
import { hasMany, Schema, t } from "./schema/index.js";

declare const repo: Repo;
declare const params: Record<string, unknown>;
declare const post: Post;

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
      string[] | ErrorMessages<typeof Note>[] | { $errors: string[]; $items: ErrorMessages<typeof Note>[] }
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

  test("includes the extra keys of the schema's own changeset function, also after a write", async () => {
    expectTypeOf<ExtraErrorKeys<typeof Account>>().toEqualTypeOf<"passwordConfirmation" | "terms">();
    const result = await repo.insert(Account.changeset(Account, params));
    if (!result.success) {
      const tree = result.error.errorMessages();
      expectTypeOf(tree.passwordConfirmation).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(tree.terms).toEqualTypeOf<string[] | undefined>();
      expectTypeOf(tree.notes).not.toBeAny();
    }
    expectTypeOf<ErrorMessages<typeof Account>["passwordConfirmation"]>().toEqualTypeOf<
      string[] | undefined
    >();
  });

  test("a changeset with extra keys is still a changeset of its schema", async () => {
    const cs = cast(User, params, ["email"]).addError("captcha", "is wrong");
    await repo.insert(cs);
    const loaded = change(post).addError("$base", "is locked");
    await repo.update(loaded);
  });

  test("ErrorMessages takes a changeset type or a schema class", () => {
    const cs = cast(User, params, ["email", "password"]).validateConfirmation("password");
    expectTypeOf<ErrorMessages<typeof cs>>().toEqualTypeOf(cs.errorMessages());
    expectTypeOf<ErrorMessages<typeof cs>>().toEqualTypeOf<
      TypedErrorTree<typeof User, "passwordConfirmation", string>
    >();
    expectTypeOf<ErrorMessages<typeof User>>().toEqualTypeOf<TypedErrorTree<typeof User, never, string>>();
    const clientSide: ErrorMessages<typeof User> = { email: ["has already been taken"] };
    expectTypeOf(clientSide).not.toBeAny();
    // @ts-expect-error a typo is a compile error
    const typo: ErrorMessages<typeof User> = { emial: ["x"] };
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
