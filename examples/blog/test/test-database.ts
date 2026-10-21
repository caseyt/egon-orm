// This repository's CI only (vitest.config.ts runs it before test/setup.ts): each test file
// gets a database of its own, as every integration test here does, and DATABASE_URL points at
// it before the application is imported. A reader's project points DATABASE_URL at its test
// database instead (see the tutorial).
import { createTestDatabase } from "@egon-orm/test-support";
import { afterAll } from "vitest";

const handle = await createTestDatabase("postgres", { label: "blog" });
process.env.DATABASE_URL = handle.db.url;

// Registered first, so it runs last: after test/setup.ts has closed the application's pool.
afterAll(() => handle.drop());
