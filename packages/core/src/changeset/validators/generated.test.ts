import { describe, expect, test } from "vitest";
import { meta, Schema, t } from "../../index.js";
import { generatedBuilders } from "./generated.js";

describe("generatedBuilders", () => {
  test("a schema class's field table has builders, made once and then kept", () => {
    class Note extends Schema("notes", { id: t.integer().primaryKey(), body: t.string() }) {}
    const fields = meta(Note).fieldsByName;
    const first = generatedBuilders(fields);
    expect(first).toBeDefined();
    expect(generatedBuilders(fields)).toBe(first);
    expect(first?.build({ body: "b" }, { id: 1, body: "a" })).toEqual({ id: 1, body: "b" });
  });
});
