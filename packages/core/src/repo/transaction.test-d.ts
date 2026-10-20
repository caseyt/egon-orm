// Type tests for transactions: the result of a callback, the value of transactionOrThrow,
// tx as a Repo, rollback as never, checkout, the options, and the test helpers.
import { User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { Changeset } from "../changeset/changeset.js";
import type { Result } from "../contracts/result.js";
import { createSandbox, expectQueries, type Sandbox } from "../testing.js";
import type { RepoQueryEvent } from "./options.js";
import type { Repo } from "./repo.js";
import type { TransactionOptions } from "./transaction.js";

declare const repo: Repo;
declare const changeset: Changeset<typeof User, true>;

describe("transaction", () => {
  test("a callback's value is the data of the result; the error is unknown", async () => {
    const result = await repo.transaction(async (tx) => {
      expectTypeOf(tx).toEqualTypeOf<Repo>();
      return tx.insertOrThrow(changeset);
    });
    expectTypeOf(result).toEqualTypeOf<Result<User, unknown>>();
    if (result.success) expectTypeOf(result.data).toEqualTypeOf<User>();
    else expectTypeOf(result.error).toBeUnknown();
    expectTypeOf(await repo.transaction(() => 3)).toEqualTypeOf<Result<number, unknown>>();
    expectTypeOf(await repo.transaction(async () => undefined)).toEqualTypeOf<Result<undefined, unknown>>();
  });

  test("transactionOrThrow gives the value itself", async () => {
    expectTypeOf(await repo.transactionOrThrow(async (tx) => tx.all(User))).toEqualTypeOf<User[]>();
    expectTypeOf(await repo.transactionOrThrow(async () => "x" as const)).toEqualTypeOf<"x">();
  });

  test("rollback never returns: `return tx.rollback(…)` narrows what follows", async () => {
    const result = await repo.transaction(async (tx) => {
      expectTypeOf(tx.rollback).returns.toBeNever();
      const created = await tx.insert(changeset);
      if (!created.success) return tx.rollback(created.error);
      expectTypeOf(created.data).toEqualTypeOf<User>();
      return created.data;
    });
    expectTypeOf(result).toEqualTypeOf<Result<User, unknown>>();
  });

  test("a bare tx.rollback(…) narrows only when tx is annotated (TypeScript's rule for never-returning calls)", async () => {
    await repo.transaction(async (tx: Repo) => {
      const created = await tx.insert(changeset);
      if (!created.success) tx.rollback(created.error);
      expectTypeOf(created.data).toEqualTypeOf<User>();
    });
    await repo.transaction(async (tx) => {
      const created = await tx.insert(changeset);
      if (!created.success) tx.rollback(created.error);
      // @ts-expect-error tx is not annotated, so the call does not narrow `created`
      created.data;
    });
  });

  test("inTransaction is a boolean and checkout gives the callback's value", async () => {
    expectTypeOf(repo.inTransaction).toEqualTypeOf<boolean>();
    expectTypeOf(await repo.checkout(async (r) => r.count(User))).toEqualTypeOf<number>();
  });

  test("the options", () => {
    const options: TransactionOptions = {
      isolation: "repeatable read",
      readOnly: true,
      retries: 2,
      timeoutMs: 100,
    };
    repo.transaction(async () => undefined, options);
    // @ts-expect-error not an isolation level
    repo.transaction(async () => undefined, { isolation: "snapshot" });
    // @ts-expect-error there is no such option
    repo.transaction(async () => undefined, { deferrable: true });
    // @ts-expect-error a callback or a batch, nothing else
    repo.transaction("begin");
  });
});

describe("egon-orm/testing", () => {
  test("createSandbox, begin, rollback and expectQueries", async () => {
    const sandbox = await createSandbox(repo);
    expectTypeOf(sandbox).toEqualTypeOf<Sandbox>();
    expectTypeOf(await sandbox.begin()).toEqualTypeOf<Repo>();
    expectTypeOf(await sandbox.rollback()).toEqualTypeOf<void>();
    expectTypeOf(await expectQueries(repo, () => repo.all(User))).toEqualTypeOf<RepoQueryEvent[]>();
  });
});
