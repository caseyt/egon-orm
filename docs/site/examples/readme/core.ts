// The checked source of the example in packages/core/README.md (the npm page of egon-orm).
// scripts/check-release-config.mjs checks that the README's copy is this region.
// #region example
import { postgres } from "@egon-orm/postgres";
import { cast, createRepo, from, Schema, t } from "egon-orm";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]).uniqueConstraint("email");
  }
}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

const result = await repo.insert(User.changeset(User, { email: "ada@example.com" }));
// A taken email is a field error, not an exception: { email: ["has already been taken"] }
if (!result.success) console.log(result.error.errorMessages());

const named = await repo.all(from(User, "u").where(({ u }) => u.name.isNotNull()));

// #endregion example

export { named };
