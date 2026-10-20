// The checked sources of the code blocks in guide/transactions.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile.
import { postgres } from "@egon-orm/postgres";
import {
  type Changeset,
  cast,
  change,
  createRepo,
  fragment,
  from,
  type Repo,
  Schema,
  t,
  timestamps,
} from "egon-orm";

class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  ...timestamps(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]).uniqueConstraint("email");
  }
}

class Profile extends Schema("profiles", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  userId: t.bigint({ mode: "number" }),
}) {}

class Order extends Schema("orders", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  total: t.integer(),
}) {}

class GiftNote extends Schema("gift_notes", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  text: t.string(),
}) {}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

declare const input: unknown;
declare const limit: number;
declare const order: Changeset<typeof Order, true>;
declare const giftNote: Changeset<typeof GiftNote, true>;
declare const a: Changeset<typeof Order, true>;
declare const b: Changeset<typeof Order, true>;
const slowQuery = from(User, "u").where(({ u }) => u.name.isNull());

export async function basics() {
  // #region basics
  const result = await repo.transaction(async (tx) => {
    const user = await tx.insertOrThrow(User.changeset(User, input));
    await tx.insertOrThrow(change(Profile, { userId: user.id }));
    return user;
  });

  if (result.success) result.data; // User
  // #endregion basics
}

export async function orThrow() {
  // #region or-throw
  const order = await repo.transactionOrThrow(async (tx) => {
    const created = await tx.insertOrThrow(change(Order, { total: 120 }));
    if (created.total > limit) tx.rollback("over the limit"); // throws RollbackError("over the limit")
    return created;
  });
  // #endregion or-throw
  return order;
}

export async function explicitRule() {
  // #region explicit-rule
  await repo.transaction(async (tx) => {
    await tx.insertOrThrow(a); // inside
    await repo.insertOrThrow(b); // NOT inside: committed even if the transaction rolls back
  });
  // #endregion explicit-rule
}

export function warning() {
  // #region warning
  const devRepo = createRepo({
    adapter: postgres({ connectionString: process.env.DATABASE_URL }),
    warnOnRootUseInTransaction: process.env.NODE_ENV !== "production",
  });
  // #endregion warning
  return devRepo;
}

export async function handleFailure() {
  // #region handle-failure
  const result = await repo.transaction(async (tx) => {
    const created = await tx.insert(User.changeset(User, input));
    if (!created.success) return tx.rollback(created.error);
    return created.data; // User: `return` above narrowed `created`
  });
  // #endregion handle-failure
  return result;
}

export async function options() {
  // #region options
  const result = await repo.transaction(
    async (tx) => {
      const seats = await tx.count(from(Order, "o"));
      if (seats >= 100) return tx.rollback("sold out");
      return tx.insertOrThrow(change(Order, { total: 1 }));
    },
    { isolation: "serializable", retries: 3, timeoutMs: 5_000 },
  );
  // #endregion options
  return result;
}

export async function nesting() {
  // #region nesting
  await repo.transaction(async (tx) => {
    await tx.insertOrThrow(order);
    const gift = await tx.transaction(async (inner) => inner.insertOrThrow(giftNote));
    if (!gift.success) {
      // the gift note was rolled back alone; the order is still there
    }
  });
  // #endregion nesting
}

export async function passTx() {
  // #region pass-tx
  async function register(db: Repo, params: unknown) {
    const user = await db.insertOrThrow(User.changeset(User, params));
    await db.insertOrThrow(change(Profile, { userId: user.id }));
    return user;
  }

  await register(repo, input); // on its own
  await repo.transaction((tx) => register(tx, input)); // inside a transaction
  // #endregion pass-tx
}

export async function checkout() {
  // #region checkout
  const users = await repo.checkout(async (r) => {
    await r.raw(fragment`select pg_advisory_lock(${42})`);
    try {
      return await r.all(slowQuery);
    } finally {
      await r.raw(fragment`select pg_advisory_unlock(${42})`);
    }
  });
  // #endregion checkout
  return users;
}
