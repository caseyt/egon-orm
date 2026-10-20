// The checked sources of the code blocks in guide/embeds.md. Each `#region` is included in
// the page by name; everything outside a region is the scaffolding that makes the regions
// compile.
import { cast, change, EmbeddedSchema, from, type Repo, Schema, t } from "egon-orm";

declare const repo: Repo;
declare const params: unknown;

// #region define
class Address extends EmbeddedSchema({
  street: t.string(),
  city: t.string(),
  postCode: t.string().nullable(),
}) {
  static changeset(address: Address | typeof Address, params: unknown) {
    return cast(address, params, ["street", "city", "postCode"]).validateRequired(["street", "city"]);
  }
}

class Phone extends EmbeddedSchema({
  id: t.uuid().primaryKey().autogenerate(),
  label: t.string(),
  number: t.string(),
}) {
  static changeset(phone: Phone | typeof Phone, params: unknown) {
    return cast(phone, params, ["label", "number"]).validateRequired(["number"]);
  }
}

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  address: t.embedOne(() => Address, { onReplace: "update" }).nullable(),
  phones: t.embedMany(() => Phone, { onReplace: "delete" }),
}) {}
// #endregion define

export function changing(user: User) {
  // #region change
  // From untrusted input
  cast(user, params, ["email"]).castEmbed("address", { with: Address.changeset, required: true });

  // From trusted data
  change(user).putEmbed("address", { street: "Karl Johans gate 1", city: "Oslo", postCode: null });
  // #endregion change
}

export async function phones(user: User) {
  // #region phones
  // params: { phones: [{ id: "…", label: "home", number: "22 00 00 00" }, { label: "work", number: "…" }] }
  const saved = await repo.updateOrThrow(cast(user, params, []).castEmbed("phones"));
  saved.phones[0] instanceof Phone; // true: rows of the embedded class
  // #endregion phones
}

export async function query() {
  // #region query
  const inOslo = await repo.all(from(User, "u").where(({ u }) => u.address.field("city").eq("Oslo")));
  // #endregion query
  return inOslo;
}
