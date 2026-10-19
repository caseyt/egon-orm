// The checked sources of the code blocks in guide/repo.md (the writing half) and
// guide/constraints.md. Each `#region` is included in a page by name; everything outside a
// region is the scaffolding that makes the regions compile.
import { postgres } from "@egon-orm/postgres";
import {
  belongsTo,
  cast,
  change,
  createRepo,
  fragment,
  from,
  hasMany,
  now,
  param,
  Schema,
  scalar,
  t,
  timestamps,
} from "egon-orm";

class User extends Schema("users", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  orgId: t.bigint({ mode: "number" }).nullable(),
  lockVersion: t.integer().default(1),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]).uniqueConstraint("email");
  }
}

class Post extends Schema("posts", {
  id: t.bigint({ mode: "number" }).primaryKey().dbGenerated(),
  authorId: t.bigint({ mode: "number" }),
  title: t.string(),
  published: t.boolean().default(false),
  views: t.integer().default(0),
  tags: t.array(t.string()).default([]),
  publishedAt: t.timestamp().nullable(),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

declare const input: unknown;
declare const params: unknown;
declare const user: User;
declare const post: Post;
declare const people: { email: string }[];

export async function results() {
  // #region result
  const result = await repo.insert(User.changeset(User, input));

  if (!result.success) {
    return result.error.errorMessages(); // result.error is the changeset
  }
  const created = result.data; // User
  // #endregion result
  return created;
}

export async function writes() {
  // #region insert
  const created = await repo.insertOrThrow(User.changeset(User, input));
  const withAll = await repo.insertOrThrow(change(User, { email: "ada@example.com" }), { returning: true });
  // #endregion insert

  // #region update
  const renamed = await repo.updateOrThrow(User.changeset(created, { name: "Ada" }));
  await repo.update(change(renamed), { force: true }); // updates updatedAt only
  const locked = await repo.update(cast(renamed, params, ["name"]).optimisticLock("lockVersion"), {
    staleError: { field: "lockVersion", message: "was changed by someone else" },
  });
  // #endregion update

  // #region delete
  await repo.deleteOrThrow(post);
  const removed = await repo.delete(change(user).noAssocConstraint("posts"));
  if (!removed.success) removed.error.errorMessages(); // { posts: ["is still associated with this entry"] }
  // #endregion delete

  // #region insert-or-update
  const saved = await repo.insertOrUpdateOrThrow(User.changeset(Math.random() > 0.5 ? user : User, input));
  // #endregion insert-or-update
  return [withAll, locked, saved];
}

export async function upserts(cs: ReturnType<typeof User.changeset>) {
  // #region upsert
  await repo.insert(cs, { onConflict: "nothing" }); // data: User | null
  await repo.insert(cs, { onConflict: { target: ["email"], update: "all" } });
  await repo.insert(cs, { onConflict: { target: ["email"], update: ["name"] } });
  await repo.insert(cs, {
    onConflict: { target: { constraint: "users_email_key" }, update: { except: ["createdAt"] } },
  });
  await repo.insert(cs, { onConflict: { target: fragment`(lower(email))`, update: ["name"] } });
  // #endregion upsert
}

export async function bulk() {
  // #region bulk
  const { count, rows } = await repo.insertAll(User, [{ email: "a@b.c" }, { email: "d@e.f" }], {
    returning: true,
  });

  await repo.updateAll(from(Post, "p").where({ authorId: 1 }).set({ published: true }));

  await repo.deleteAll(from(Post, "p").where({ published: false }));
  // #endregion bulk

  // #region bulk-values
  await repo.insertAll(
    Post,
    people.map((person) => ({
      authorId: scalar(
        from(User, "u")
          .where({ email: person.email })
          .select(({ u }) => u.id),
      ),
      title: `Welcome, ${person.email}`,
      publishedAt: param("launch", t.timestamp()),
    })),
    { placeholders: { launch: new Date("2026-11-01T09:00:00Z") } },
  );
  await repo.insertAll(Post, [{ authorId: 1, title: "Now", publishedAt: now() }]);
  // INSERT … SELECT: the select's keys are the fields to fill.
  await repo.insertAll(
    Post,
    from(User, "u").select(({ u }) => ({ authorId: u.id, title: u.email })),
  );
  // #endregion bulk-values

  // #region bulk-update
  const { rows: bumped } = await repo.updateAll(
    from(Post, "p")
      .where(({ p }) => p.published)
      .set(({ p }) => ({ views: p.views.add(1), tags: p.tags.append("popular") }))
      .returning(({ p }) => ({ id: p.id, views: p.views })),
  ); // { id: number; views: number }[] | null
  // #endregion bulk-update
  return [count, rows, bumped];
}

export async function constraints() {
  // #region constraints
  const cs = cast(User, params, ["email", "orgId"]).uniqueConstraint("email").foreignKeyConstraint("orgId");

  const result = await repo.insert(cs);
  if (!result.success) result.error.errorMessages(); // { email: ["has already been taken"] }
  // #endregion constraints

  // #region constraint-name
  cast(User, params, ["email"]).uniqueConstraint("email", { name: "uq_users_email" });
  // #endregion constraint-name

  // #region early-feedback
  const checked = await cast(User, params, ["email"])
    .uniqueConstraint("email")
    .validateUniqueAsync("email", repo);
  if (checked.valid) await repo.insert(checked);
  // #endregion early-feedback
}
