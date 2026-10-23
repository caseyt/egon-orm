// The checked source of the editor-completions entry in guide/faq.md. The region is
// included in the page by name; everything outside it makes it compile and checks it.
import { type Changeset, cast, Schema, t } from "egon-orm";

// #region completions
class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  password: t.string().virtual(),
  passwordHash: t.string().redact(),
}) {
  // Declared, so the editor reads this type instead of inferring the chain below. The
  // third argument lists the error keys the validations add that are not fields.
  static changeset(
    user: User | typeof User,
    params: unknown,
  ): Changeset<typeof User, boolean, "passwordConfirmation"> {
    return cast(user, params, ["email", "password"])
      .validateRequired(["email", "password"])
      .validateLength("password", { min: 12 })
      .validateConfirmation("password");
  }
}
// #endregion completions

declare const params: unknown;

// The declared type keeps the added key: errorMessages() still has passwordConfirmation.
export function confirmationMessages(): readonly string[] | undefined {
  return User.changeset(User, params).errorMessages().passwordConfirmation;
}
