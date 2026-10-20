// The application that docs/site/examples/testing.ts tests: a repo, a schema and two
// functions, standing for the reader's own `src/`, and a test-data helper (the `factory`
// region, which guide/testing.md includes).
import { postgres } from "@egon-orm/postgres";
import { cast, change, createRepo, from, type InsertShape, Schema, t } from "egon-orm";

export class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {}

export const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

export function register(params: { email: string }) {
  return repo.insert(cast(User, params, ["email"]).uniqueConstraint("email"));
}

export async function loadFeed(userId: number) {
  const user = await repo.getOrThrow(User, userId);
  return repo.all(from(User, "u").where({ name: user.name }));
}

export const userId = 1;

// #region factory
export const insertUser = (attrs: Partial<InsertShape<typeof User>> = {}) =>
  repo.insertOrThrow(change(User, { email: `user${Math.random()}@example.com`, ...attrs }));
// #endregion factory
