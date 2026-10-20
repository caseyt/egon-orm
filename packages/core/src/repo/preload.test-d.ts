// Type tests for preloading through the repo: what `repo.all` returns for each preload
// form, `repo.preload` (every spec form, the callback form, cumulative loads, one row, an
// array, null), `isLoaded` narrowing, `assoc()` queries, the nullability of `belongsTo`,
// and the calls that must not compile.
import { Comment, Membership, type Org, Post, type Profile, type Tag, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { Loaded, LoadedAs, Row } from "../contracts/schema.js";
import { assoc, isLoaded } from "../query/assoc.js";
import { from, type PreloadQuery, type QueryResult } from "../query/builder.js";
import { param } from "../query/functions.js";
import { t } from "../schema/index.js";
import type { Repo } from "./repo.js";

declare const repo: Repo;
declare const user: User;
declare const users: User[];
declare const post: Post;

describe("reads with preloads", () => {
  test("repo.all returns the loaded rows, three levels deep", async () => {
    const rows = await repo.all(from(User, "u").preload({ posts: { comments: "author" } }));
    expectTypeOf(rows).not.toBeAny();
    expectTypeOf(rows[0]?.posts[0]?.comments[0]?.author).toEqualTypeOf<User | null | undefined>();
    const one = await repo.oneOrThrow(from(User, "u").preload(["profile", "orgs"]));
    expectTypeOf(one.profile).toEqualTypeOf<Profile | null>();
    expectTypeOf(one.orgs).toEqualTypeOf<Org[]>();
    expectTypeOf(one.displayName).toEqualTypeOf<string>();
  });

  test("belongsTo is nullable exactly when its foreign key is", async () => {
    const posts = await repo.all(from(Post, "p").preload("author"));
    expectTypeOf(posts[0]?.author).toEqualTypeOf<User | undefined>();
    const comments = await repo.all(from(Comment, "c").preload(["author", "post"]));
    expectTypeOf(comments[0]?.author).toEqualTypeOf<User | null | undefined>();
    expectTypeOf(comments[0]?.post).toEqualTypeOf<Post | undefined>();
    const memberships = await repo.all(from(Membership, "m").preload("org"));
    expectTypeOf(memberships[0]?.org).toEqualTypeOf<Org | undefined>();
  });

  test("the options take maxConcurrency", async () => {
    await repo.all(from(User, "u").preload(["posts", "profile"]), { maxConcurrency: 2 });
    // @ts-expect-error maxConcurrency is a number
    await repo.all(from(User, "u").preload("posts"), { maxConcurrency: "2" });
  });
});

describe("repo.preload", () => {
  test("every spec form types the loaded rows", async () => {
    const posts = await repo.preload(User, users, "posts");
    expectTypeOf(posts).toEqualTypeOf<(User & { posts: Post[] })[]>();
    const several = await repo.preload(User, users, ["posts", "profile"]);
    expectTypeOf(several[0]?.profile).toEqualTypeOf<Profile | null | undefined>();
    const nested = await repo.preload(User, users, { posts: ["comments", "tags"] });
    expectTypeOf(nested[0]?.posts[0]?.tags).toEqualTypeOf<Tag[] | undefined>();
    const deep = await repo.preload(User, users, { posts: { comments: "author" } });
    expectTypeOf(deep[0]?.posts[0]?.comments[0]?.author).toEqualTypeOf<User | null | undefined>();
  });

  test("one row, or null, as given", async () => {
    const one = await repo.preload(User, user, "profile");
    expectTypeOf(one.profile).toEqualTypeOf<Profile | null>();
    const maybe: User | null = null as User | null;
    const either = await repo.preload(User, maybe, "posts");
    expectTypeOf(either).toEqualTypeOf<(User & { posts: Post[] }) | null>();
  });

  test("the callback form: whole rows, or the selected shape", async () => {
    const top = await repo.preload(User, users, "posts", (q) =>
      q.orderBy(({ posts }) => posts.views.desc()).limit(3),
    );
    expectTypeOf(top[0]?.posts).toEqualTypeOf<Post[] | undefined>();
    const shaped = await repo.preload(User, user, "posts", (q) =>
      q.select(({ posts }) => ({ authorId: posts.authorId, title: posts.title })),
    );
    expectTypeOf(shaped.posts).toEqualTypeOf<{ authorId: number; title: string }[]>();
    const forced = await repo.preload(
      User,
      user,
      "posts",
      (q) => q.where(({ posts }) => posts.views.gte(10)),
      {
        force: true,
      },
    );
    expectTypeOf(forced.posts).toEqualTypeOf<Post[]>();
    // @ts-expect-error the callback runs at once: values, not named parameters
    void repo.preload(User, user, "posts", (q) =>
      q.where(({ posts }) => posts.views.gte(param("minViews", t.integer()))),
    );
  });

  test("loads add up: Loaded<S, A> preloaded with B is loaded with both", async () => {
    const withPosts = await repo.preload(User, users, "posts");
    const both = await repo.preload(User, withPosts, "profile");
    expectTypeOf(both[0]?.posts).toEqualTypeOf<Post[] | undefined>();
    expectTypeOf(both[0]?.profile).toEqualTypeOf<Profile | null | undefined>();
    const declared: Loaded<typeof User, "posts">[] = withPosts;
    const again = await repo.preload(User, declared, { posts: "comments" }, { force: true });
    expectTypeOf(again[0]?.posts[0]?.comments).toEqualTypeOf<Comment[] | undefined>();
    // A selected shape loaded over rows replaces them.
    const shaped = await repo.preload(User, withPosts, "posts", (q) =>
      q.select(({ posts }) => ({ authorId: posts.authorId })),
    );
    expectTypeOf(shaped[0]?.posts).toEqualTypeOf<{ authorId: number }[] | undefined>();
  });

  test("what does not compile", () => {
    // @ts-expect-error User has no association nope
    void repo.preload(User, users, "nope");
    // @ts-expect-error Post has no association nope
    void repo.preload(User, users, { posts: "nope" });
    // @ts-expect-error rows of another schema
    void repo.preload(User, [post], "posts");
    // @ts-expect-error the select lacks authorId, the key of User.posts
    void repo.preload(User, users, "posts", (q) => q.select(({ posts }) => ({ title: posts.title })));
    // @ts-expect-error force is a boolean
    void repo.preload(User, users, "posts", { force: 1 });
  });
});

describe("isLoaded", () => {
  test("narrows a row to one with the association", () => {
    if (isLoaded(User, user, "posts")) {
      expectTypeOf(user.posts).toEqualTypeOf<Post[]>();
    }
    if (isLoaded(Post, post, "author")) {
      expectTypeOf(post.author).toEqualTypeOf<User>();
    }
    // @ts-expect-error User has no association nope
    isLoaded(User, user, "nope");
    // @ts-expect-error the association is not on the plain row
    void user.posts;
  });
});

describe("assoc", () => {
  test("is a query rooted at the target, under the association's name", async () => {
    const query = assoc(User, user, "posts");
    expectTypeOf(query).toEqualTypeOf<PreloadQuery<typeof User, "posts">>();
    expectTypeOf<QueryResult<typeof query>>().toEqualTypeOf<Post>();
    const drafts = await repo.all(
      assoc(User, users, "posts").where(({ posts }) => posts.published.eq(false)),
    );
    expectTypeOf(drafts).toEqualTypeOf<Post[]>();
    const tags = await repo.all(assoc(Post, post, "tags").preload("posts"));
    expectTypeOf(tags[0]?.posts).toEqualTypeOf<Post[] | undefined>();
    // @ts-expect-error Post has no association nope
    assoc(Post, post, "nope");
    // @ts-expect-error a row of another schema
    assoc(User, post, "posts");
  });
});

describe("LoadedAs", () => {
  test("types an association loaded as a shape", () => {
    type Shaped = LoadedAs<typeof User, "posts", { authorId: number }>;
    expectTypeOf<Shaped["posts"]>().toEqualTypeOf<{ authorId: number }[]>();
    expectTypeOf<Shaped["email"]>().toEqualTypeOf<Row<typeof User>["email"]>();
  });
});
