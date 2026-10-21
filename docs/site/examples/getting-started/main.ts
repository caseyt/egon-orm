// @run after: ./setup.ts
// The checked source of the first-steps blocks of guide/getting-started.md: one file of the
// reader's project, main.ts, shown in parts (each `#region`). docs:integration runs
// setup.ts, then this file, and checks the `// =>` comments.
// #region imports
// main.ts: run it with npx tsx main.ts
import { count, from } from "egon-orm";
import { repo } from "./repo.js";
import { User } from "./schemas.js";

// #endregion imports

// #region insert
const result = await repo.insert(User.changeset(User, { email: "ada@example.com" }));

if (result.success) {
  console.log(result.data.id); // a User: id, createdAt and updatedAt are filled in
} else {
  console.log(result.error.errorMessages()); // { email: ["has already been taken"] }
}
// #endregion insert

// #region query
const found = await repo.getBy(User, { email: "ada@example.com" }); // type: User | null
found?.email; // => "ada@example.com"

const counts = await repo.all(
  from(User, "u")
    .leftJoinAssoc("u", "posts", "p")
    .groupBy(({ u }) => u.id)
    .select(({ u, p }) => ({ email: u.email, posts: count(p.id) })),
); // type: { email: string; posts: number }[]
counts[0]; // => { email: "ada@example.com", posts: 0 }

const withPosts = await repo.all(from(User, "u").preload("posts"));
// The first user's posts, none yet. Their type is Post[]: the query preloaded them.
withPosts[0]?.posts; // => []
// #endregion query

// #region update
const ada = await repo.getByOrThrow(User, { email: "ada@example.com" });
const renamed = await repo.updateOrThrow(User.changeset(ada, { name: "Ada" }));
renamed.name; // => "Ada"
await repo.deleteOrThrow(renamed);
// #endregion update

// #region close
await repo.close(); // waits for running queries, then closes the pool
// #endregion close
