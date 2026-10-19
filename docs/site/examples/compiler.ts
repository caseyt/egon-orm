// The checked sources of the code blocks in internals/compiler.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile.
import { from, param, type Repo, Schema, t, timestamps } from "egon-orm";

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  ...timestamps(),
}) {}

declare const repo: Repo;

// #region module-level
// Built once, when the module loads: compiled once per database schema, ever.
const adults = from(User, "u")
  .where(({ u }) => u.age.gte(param("minAge", t.integer())))
  .select(({ u }) => ({ id: u.id, email: u.email }));

export async function listAdults(minAge: number) {
  return repo.all(adults, { minAge });
}
// #endregion module-level

// #region per-request
// Built on every call with another value: every call has the same shape, so after the
// first one each call finds the plan by its shape and binds its own value.
export async function listByRole(role: "admin" | "member") {
  return repo.all(from(User, "u").where(({ u }) => u.role.eq(role)));
}
// #endregion per-request

export function inspect() {
  // #region to-sql
  const { sql, params } = repo.toSql(
    from(User, "u")
      .where(({ u }) => u.age.gte(18))
      .orderBy(({ u }) => u.createdAt.desc())
      .limit(10)
      .select(({ u }) => ({ id: u.id, email: u.email })),
  );
  // #endregion to-sql
  return { sql, params };
}
