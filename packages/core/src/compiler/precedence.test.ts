// The precedence each expression is written with, which decides where the emitter puts
// parentheses. Stated here operator by operator, so that a wrong entry does not depend on a
// snapshot that happens to need parentheses.
import { describe, expect, test } from "vitest";
import type { BinaryOp } from "../contracts/query.js";
import { binaryNode, jsonPathNode, literalNode, naryNode, unaryNode } from "../query/ast.js";
import { mysqlDialect, postgresDialect, sqliteDialect } from "./dialect.js";
import { precedenceOf } from "./emit.js";
import { PRECEDENCE } from "./registry.js";
import { col, value } from "./sql-fixtures.js";

const a = col("u", "a");
const b = col("u", "b");

const BINARY: Readonly<Record<Exclude<BinaryOp, "in" | "notIn" | "has">, number>> = {
  eq: PRECEDENCE.comparison,
  neq: PRECEDENCE.comparison,
  gt: PRECEDENCE.comparison,
  gte: PRECEDENCE.comparison,
  lt: PRECEDENCE.comparison,
  lte: PRECEDENCE.comparison,
  isDistinctFrom: PRECEDENCE.is,
  like: PRECEDENCE.like,
  notLike: PRECEDENCE.like,
  ilike: PRECEDENCE.like,
  add: PRECEDENCE.additive,
  sub: PRECEDENCE.additive,
  mul: PRECEDENCE.multiplicative,
  div: PRECEDENCE.multiplicative,
  mod: PRECEDENCE.multiplicative,
  concat: PRECEDENCE.other,
  contains: PRECEDENCE.other,
  containedBy: PRECEDENCE.other,
  overlaps: PRECEDENCE.other,
};

describe("precedenceOf", () => {
  test.each(Object.entries(BINARY))("%s on Postgres", (op, expected) => {
    expect(precedenceOf(postgresDialect, binaryNode(op as BinaryOp, a, b))).toBe(expected);
  });

  test("MySQL writes concat as a function and isDistinctFrom as not (a <=> b)", () => {
    expect(precedenceOf(mysqlDialect, binaryNode("concat", a, b))).toBe(PRECEDENCE.atom);
    expect(precedenceOf(mysqlDialect, binaryNode("isDistinctFrom", a, b))).toBe(PRECEDENCE.not);
    expect(precedenceOf(sqliteDialect, binaryNode("concat", a, b))).toBe(PRECEDENCE.other);
    expect(precedenceOf(sqliteDialect, binaryNode("isDistinctFrom", a, b))).toBe(PRECEDENCE.is);
  });

  test("a negative number, and negative zero, is written as a unary minus", () => {
    expect(precedenceOf(postgresDialect, literalNode(-1))).toBe(PRECEDENCE.unary);
    expect(precedenceOf(postgresDialect, literalNode(-0))).toBe(PRECEDENCE.unary);
    expect(precedenceOf(postgresDialect, literalNode(0))).toBe(PRECEDENCE.atom);
    expect(precedenceOf(postgresDialect, literalNode(2))).toBe(PRECEDENCE.atom);
    expect(precedenceOf(postgresDialect, literalNode(true))).toBe(PRECEDENCE.atom);
  });

  test("and/or: none is an atom, one is its argument, more are and or or", () => {
    const sum = binaryNode("add", a, b);
    expect(precedenceOf(postgresDialect, naryNode("and", []))).toBe(PRECEDENCE.atom);
    expect(precedenceOf(postgresDialect, naryNode("or", [sum]))).toBe(PRECEDENCE.additive);
    expect(precedenceOf(postgresDialect, naryNode("and", [a, b]))).toBe(PRECEDENCE.and);
    expect(precedenceOf(postgresDialect, naryNode("or", [a, b]))).toBe(PRECEDENCE.or);
  });

  test("a JSON path is an operator, or a function call on MySQL", () => {
    const path = jsonPathNode(a, [value("k")], false);
    expect(precedenceOf(postgresDialect, path)).toBe(PRECEDENCE.other);
    expect(precedenceOf(sqliteDialect, path)).toBe(PRECEDENCE.other);
    expect(precedenceOf(mysqlDialect, path)).toBe(PRECEDENCE.atom);
  });

  test("unary operators", () => {
    expect(precedenceOf(postgresDialect, unaryNode("not", a))).toBe(PRECEDENCE.not);
    expect(precedenceOf(postgresDialect, unaryNode("isNull", a))).toBe(PRECEDENCE.is);
    expect(precedenceOf(postgresDialect, unaryNode("isNotNull", a))).toBe(PRECEDENCE.is);
    expect(precedenceOf(postgresDialect, unaryNode("neg", a))).toBe(PRECEDENCE.unary);
  });
});
