// The checked sources of the code blocks in guide/testing.md: a test file as a reader would
// write it, testing the application in ./testing-app.ts. Each `#region` is included in the
// page by name. (Vitest is the workspace's own test runner.)

// #region import
import { createSandbox, expectQueries } from "egon-orm/testing";
// #endregion import
// #region sandbox-imports
import { afterEach, beforeEach, expect, test } from "vitest";
import { loadFeed, register, repo, User, userId } from "./testing-app.js";

// #endregion sandbox-imports

// #region sandbox
const sandbox = await createSandbox(repo);

beforeEach(() => sandbox.begin());
afterEach(() => sandbox.rollback());

test("registers a user", async () => {
  await register({ email: "ada@example.com" }); // application code using `repo`
  expect(await repo.count(User)).toBe(1);
});
// #endregion sandbox

// #region expected-failure
test("refuses a second account with the same email", async () => {
  await register({ email: "ada@example.com" });
  const second = await register({ email: "ada@example.com" }); // the database refuses it
  expect(second.success).toBe(false);
  expect(await repo.count(User)).toBe(1); // and the test carries on
});
// #endregion expected-failure

// #region count-queries
test("loads the feed in two queries", async () => {
  const queries = await expectQueries(repo, () => loadFeed(userId));
  expect(queries).toHaveLength(2);
});
// #endregion count-queries
