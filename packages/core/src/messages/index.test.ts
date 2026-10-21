import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type EgonError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  SchemaDefinitionError,
  useFullErrorMessages,
} from "../errors.js";
import { explain, messages } from "./index.js";

// The default: short messages (the test setup turns full ones on for the other tests).
beforeEach(() => {
  useFullErrorMessages(null);
});

afterEach(() => {
  vi.resetModules();
});

describe("explain", () => {
  test("gives the full text of an Egon error: identifier, short sentence, advice, link", () => {
    const error = new NotLoadedError({ schema: "User", association: "posts" });
    expect(explain(error)).toBe(
      'notLoaded: Association "posts" of User is not loaded. Preload it first: add .preload("posts") to the query, or call repo.preload(rows, "posts"). See https://egon-orm.github.io/egon-orm/reference/errors/general#notloaded',
    );
    // It reads no global state, and changes none.
    expect(error.message).not.toContain("Preload it first");
    expect(new NoResultsError().message).not.toContain("OrThrow");
  });

  test("explains an error made while a module was imported, before useFullErrorMessages could run", async () => {
    vi.resetModules();
    let thrown: unknown;
    try {
      // A schema module that fails at import time.
      const { Schema, t } = await import("../schema/index.js");
      Schema("users", { name: t.string() });
    } catch (error) {
      thrown = error;
    }
    const fresh = await import("./index.js");
    expect((thrown as EgonError).id).toBe("schema.noPrimaryKey");
    expect((thrown as EgonError).message).not.toContain("Add .primaryKey()");
    expect(fresh.explain(thrown)).toContain("Add .primaryKey() to the key field");
  });

  test("takes a catalog of one's own", () => {
    const error = new NoResultsError();
    expect(explain(error, { noResults: "Prüfen Sie die ID." })).toBe(
      "noResults: Expected at least one result but got none. Prüfen Sie die ID. See https://egon-orm.github.io/egon-orm/reference/errors/general#noresults",
    );
  });

  test("gives the message as it is for an identifier the catalog has no entry for", () => {
    const error = new QueryError("query.unsupportedFeature", "FULL JOIN is not supported by sqlite.");
    expect(explain(error, {})).toBe(error.message);
  });

  test("gives the message as it is for an Egon error of another copy of the package", () => {
    const foreign = Object.assign(new Error("schema.noPrimaryKey: no key. See …"), {
      id: "schema.noPrimaryKey",
      code: "schemaDefinition",
      [Symbol.for("egon.error")]: true,
    });
    expect(explain(foreign)).toBe("schema.noPrimaryKey: no key. See …");
  });

  test("gives name: message for any other Error, and String(value) for anything else", () => {
    expect(explain(new TypeError("x is not a function"))).toBe("TypeError: x is not a function");
    expect(explain("boom")).toBe("boom");
    expect(explain(42)).toBe("42");
    expect(explain(undefined)).toBe("undefined");
    expect(explain(null)).toBe("null");
  });

  test("gives the same text useFullErrorMessages puts in the message", () => {
    const error = new SchemaDefinitionError("schema.nullableKey", "User.id is a primary key and nullable.");
    useFullErrorMessages(messages);
    const full = new SchemaDefinitionError("schema.nullableKey", "User.id is a primary key and nullable.");
    expect(explain(error)).toBe(full.message);
  });
});

describe("the catalog", () => {
  test("has an entry, with advice, for every identifier", () => {
    const entries = Object.entries(messages);
    expect(entries.length).toBeGreaterThan(500);
    for (const [id, advice] of entries) {
      expect(id).toMatch(/^([a-z]+\.[a-zA-Z0-9]+|[a-z][a-zA-Z]+)$/);
      expect(advice.trim().length, id).toBeGreaterThan(0);
    }
  });
});
