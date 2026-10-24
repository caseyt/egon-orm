// A runtime that allows code generation at first and refuses it later (Cloudflare Workers:
// allowed while the script starts, an EvalError afterwards). Whenever the refusal starts,
// even between the functions generated for one schema, validate() still sees the values:
// what was not generated is done with loops. Modules are loaded afresh for each case.
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Refuses `new Function` after `allowed` constructions. */
function refuseAfter(allowed: number): void {
  let left = allowed;
  vi.stubGlobal(
    "Function",
    new Proxy(Function, {
      construct(target, args: unknown[]) {
        if (left <= 0) throw new EvalError("Code generation from strings disallowed for this context");
        left--;
        return new target(...(args as string[]));
      },
    }),
  );
}

test.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
  "refused after %i generated functions: the validator sees the values all the same",
  async (allowed) => {
    vi.resetModules();
    refuseAfter(allowed);
    const { cast } = await import("../changeset.js");
    const { Schema, t } = await import("../../schema/index.js");
    class Lamp extends Schema("lamps", {
      id: t.integer().primaryKey(),
      label: t.string(),
      watts: t.integer(),
    }) {}
    let seen: unknown;
    cast(Lamp, { label: "desk", watts: "40" }, ["label", "watts"]).validate((values) => {
      seen = values;
    });
    expect(seen).toStrictEqual({ label: "desk", watts: 40 });
  },
);
