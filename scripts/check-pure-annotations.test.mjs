// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findInModule, findProblems } from "./check-pure-annotations.mjs";

const messages = (text) => findInModule(text).map((p) => `${p.line}: ${p.message}`);

describe("findInModule", () => {
  test("accepts annotated calls and news in top-level declarations, nested ones too", () => {
    const text = [
      "const A = /* @__PURE__ */ Object.freeze({ b: /* @__PURE__ */ Object.freeze([1]) });",
      "export const M = /* @__PURE__ */ new Map();",
      "const S: unique symbol = /* #__PURE__ */ Symbol.for('x');",
      "const N = 1, T = 'text';",
    ].join("\n");
    assert.deepEqual(messages(text), []);
  });

  test("refuses a call or new without the annotation, and says where", () => {
    const text = [
      "const ok = 1;",
      "const A = Object.freeze({});",
      "const B = /* @__PURE__ */ f(g());",
      "const C = new Set();",
    ].join("\n");
    assert.deepEqual(messages(text), [
      "2: a call evaluated when the module loads has no /* @__PURE__ */",
      "3: a call evaluated when the module loads has no /* @__PURE__ */",
      "4: a call evaluated when the module loads has no /* @__PURE__ */",
    ]);
  });

  test("does not look inside functions, methods or class bodies", () => {
    const text = [
      "function f() { return Object.freeze([]); }",
      "const g = () => new Map();",
      "const h = function () { return x(); };",
      "class C { m() { return y(); } get z() { return w(); } }",
      "const o = { m() { return q(); } };",
    ].join("\n");
    assert.deepEqual(messages(text), []);
  });

  test("checks the static fields of a top-level class, and allows a static block", () => {
    const text = "class C {\n  static a = Object.freeze([]);\n  b = make();\n  static { hook = () => 1; }\n}";
    assert.deepEqual(messages(text), ["2: a call evaluated when the module loads has no /* @__PURE__ */"]);
  });

  test("refuses a spread inside an annotated call, in an array or an object", () => {
    const text = [
      "const A = /* @__PURE__ */ Object.freeze([...B, 1]);",
      "const C = /* @__PURE__ */ Object.freeze({ ...D, e: 1 });",
      "const E = [...F];",
    ].join("\n");
    assert.deepEqual(messages(text), [
      "1: a spread inside a call evaluated when the module loads keeps the call alive; build the value without it",
      "2: a spread inside a call evaluated when the module loads keeps the call alive; build the value without it",
    ]);
  });

  test("refuses a chained call, which one annotation cannot cover", () => {
    assert.deepEqual(messages("const A = /* @__PURE__ */ B.filter(f).concat([1]);"), [
      "1: a call on the result of another call cannot have both annotated; split it",
    ]);
  });

  test("refuses a top-level statement that runs something, and a tagged template", () => {
    assert.deepEqual(messages("register(plugin);\nconst Q = sql`select 1`;"), [
      "1: a top-level statement runs when the module loads; give it no side effect, or move it into a function",
      "2: a tagged template evaluated when the module loads cannot be annotated as pure",
    ]);
  });

  test("offers the position of the annotation to insert", () => {
    const [problem] = findInModule("const A = Object.freeze([]);");
    assert.equal(problem?.fix, "const A = ".length);
  });
});

test("every published module of the repository is provably pure when it loads", () => {
  assert.deepEqual(findProblems(), []);
});
