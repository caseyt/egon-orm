// A bound value is marked for redaction in logs when the parameter says so, or when its
// type is an embed with a redacted field: named and positional parameters alike.
import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ExprNode } from "../contracts/query.js";
import { EmbeddedSchema, from, t } from "../index.js";
import { namedParamNode, paramNode } from "../query/ast.js";
import { embedType } from "../types/embed.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { rebuild, selectOne, typeOf } from "./sql-fixtures.js";

class Secret extends EmbeddedSchema({ pin: t.string().redact() }) {}
class Plain extends EmbeddedSchema({ note: t.string() }) {}

const TEXT = typeOf(t.string());
const SECRET = embedType("one", () => Secret);
const PLAIN = embedType("one", () => Plain);

const redacted = (node: ExprNode) =>
  createCompiler(postgresDialect).compile(
    rebuild(from(User, "u").ast, { select: selectOne(node) }),
    "all",
    undefined,
  ).slots[0]?.redact;

describe("redaction of a bound value", () => {
  test("a named parameter", () => {
    expect(redacted(namedParamNode("k", TEXT, false))).toBe(false);
    expect(redacted(namedParamNode("k", TEXT, true))).toBe(true);
    expect(redacted(namedParamNode("k", SECRET, false))).toBe(true);
    expect(redacted(namedParamNode("k", PLAIN, false))).toBe(false);
  });

  test("a positional parameter", () => {
    expect(redacted(paramNode(1, TEXT, false))).toBe(false);
    expect(redacted(paramNode(1, TEXT, true))).toBe(true);
    expect(redacted(paramNode({ pin: "1" }, SECRET, false))).toBe(true);
    expect(redacted(paramNode({ note: "x" }, PLAIN, false))).toBe(false);
  });
});
