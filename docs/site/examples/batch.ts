// The checked sources of the code blocks in guide/batch.md. Each `#region` is included in
// the page by name; everything outside a region is the scaffolding that makes the regions
// compile.
import { postgres } from "@egon-orm/postgres";
import {
  Batch,
  cast,
  change,
  createBatch,
  createRepo,
  failure,
  from,
  type Repo,
  Schema,
  success,
  t,
} from "egon-orm";

class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
}) {
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]).uniqueConstraint("email");
  }
}

class Profile extends Schema("profiles", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  userId: t.bigint({ mode: "number" }),
}) {}

class AuditLog extends Schema("audit_logs", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  userId: t.bigint({ mode: "number" }),
  action: t.string(),
}) {}

class Post extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  published: t.boolean().default(false),
}) {}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

declare const input: unknown;
declare function queueWelcomeEmail(tx: Repo, user: User): Promise<boolean>; // false when the queue is full

// #region sign-up
const signUp = createBatch()
  .insert("user", User.changeset(User, input))
  .insert("profile", ({ user }) => change(Profile, { userId: user.id }))
  .run("welcome", async (tx, { user }) =>
    (await queueWelcomeEmail(tx, user)) ? success(true) : failure("the queue is full"),
  );

const result = await repo.transaction(signUp);

if (result.success) {
  result.data.user; // User
  result.data.profile; // Profile
} else {
  result.error.step; // "user" | "profile" | "welcome"
  result.error.error; // what that step failed with
  result.error.completed; // the results of the steps before it
}
// #endregion sign-up

export function steps() {
  // #region steps
  const publishAll = createBatch()
    .one("author", from(User, "u").where({ email: "ada@example.com" }))
    .run("found", async (_tx, { author }) => (author === null ? failure("no such author") : success(author)))
    .updateAll("published", ({ found }) =>
      from(Post, "p").where({ authorId: found.id }).set({ published: true }),
    )
    .put("source", "admin")
    .inspect((results) => process.stderr.write(`${Object.keys(results).join(", ")}\n`));
  // #endregion steps
  return publishAll;
}

// #region compose
const audit = (action: string) => (results: { user: User }) =>
  createBatch().insert("audit", change(AuditLog, { userId: results.user.id, action }));

const withAudit = signUp.merge(audit("signed_up"));
// #endregion compose

export function listing() {
  // #region to-list
  const names = Batch.toList(withAudit).map((step) => `${step.operation} ${step.name ?? ""}`);
  // ["insert user", "insert profile", "run welcome", "merge "]
  // #endregion to-list
  return names;
}

export function handle() {
  // #region handle
  if (!result.success) {
    switch (result.error.step) {
      case "user":
        return result.error.error.errorMessages(); // Changeset<typeof User>
      case "profile":
        return result.error.error.errorMessages(); // Changeset<typeof Profile>
      case "welcome":
        return { email: [result.error.error] }; // "the queue is full"
    }
  }
  // #endregion handle
  return undefined;
}

export async function orThrow() {
  // #region or-throw
  const { user, profile } = await repo.transactionOrThrow(signUp); // a failure throws RollbackError
  // #endregion or-throw
  return [user, profile];
}
