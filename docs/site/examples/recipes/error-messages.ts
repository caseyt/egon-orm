// @run
// The checked source of recipes/translating-errors.md. Each `#region` is included in the page
// by name; the rest makes it compile (docs:integration runs it and checks the `// =>` comments).
// #region setup
import { type ChangesetError, cast, Schema, t, traverseErrors } from "egon-orm";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string(),
  age: t.integer().nullable(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name", "age"])
      .validateRequired(["email", "name"])
      .validateLength("name", { min: 2 })
      .validateNumber("age", { greaterThanOrEqualTo: 13 })
      .uniqueConstraint("email");
  }
}
// #endregion setup

// #region catalogue
// The default messages are the keys. Placeholders such as {count} are filled from meta.
type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>;

const fr: Record<string, Entry> = {
  "can't be blank": "doit être rempli",
  "has already been taken": "est déjà utilisé",
  "is invalid": "n'est pas valide",
  "should be at least {count} character(s)": {
    one: "doit contenir au moins {count} caractère",
    other: "doit contenir au moins {count} caractères",
  },
  "must be greater than or equal to {number}": "doit être supérieur ou égal à {number}",
};

export function translator(catalogue: Record<string, Entry>, locale: string) {
  const plurals = new Intl.PluralRules(locale);
  return (error: ChangesetError): string => {
    const entry = catalogue[error.message] ?? error.message; // unknown messages stay as they are
    const count = error.meta.count;
    const template =
      typeof entry === "string"
        ? entry
        : (entry[typeof count === "number" ? plurals.select(count) : "other"] ??
          entry.other ??
          error.message);
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
      key in error.meta ? String(error.meta[key]) : match,
    );
  };
}
// #endregion catalogue

export async function run(): Promise<void> {
  // #region use
  const changeset = User.changeset(User, { email: "", name: "A", age: 9 });

  traverseErrors(changeset, translator(fr, "fr"));
  // #endregion use
  traverseErrors(changeset, translator(fr, "fr")); // => { email: ["doit être rempli"], name: ["doit contenir au moins 2 caractères"], age: ["doit être supérieur ou égal à 13"] }
  changeset.errorMessages().name; // => ["should be at least 2 character(s)"]
}
