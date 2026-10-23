import { describe, expect, test } from "vitest";
import type { QueryNode } from "../contracts/query.js";
import { QueryError } from "../errors.js";
import { type NodeEmitter, PRECEDENCE, registeredEmitter, registerNodeEmitter } from "./registry.js";

/**
 * Every node kind of the query contract, written out: an extension must not be able to take
 * one of them over. The type check below fails when the contract gains or loses a kind.
 */
const CONTRACT_KINDS = [
  "column",
  "param",
  "namedParam",
  "list",
  "literal",
  "unary",
  "binary",
  "between",
  "nary",
  "fn",
  "aggregate",
  "ident",
  "fragment",
  "cast",
  "case",
  "jsonPath",
  "subquery",
  "exists",
  "tuple",
  "selectedAs",
  "star",
  "order",
  "window",
  "table",
  "cteSource",
  "subquerySource",
  "values",
  "fragmentSource",
  "join",
  "bool",
  "select",
  "distinct",
  "lock",
  "combination",
  "cte",
  "windowDef",
  "preload",
  "update",
  "query",
] as const satisfies readonly QueryNode["kind"][];

type Missing = Exclude<QueryNode["kind"], (typeof CONTRACT_KINDS)[number]>;
const everyKindListed: [Missing] extends [never] ? true : Missing = true;

const emitter: NodeEmitter = { precedence: PRECEDENCE.atom, emit: () => "true", sameShape: () => true };

/** What `run` threw, or `undefined` when it returned. */
function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("registerNodeEmitter", () => {
  test("the list above names every kind of the contract", () => {
    expect(everyKindListed).toBe(true);
    expect(new Set(CONTRACT_KINDS).size).toBe(CONTRACT_KINDS.length);
  });

  test.each(CONTRACT_KINDS)("refuses the built-in kind %s", (kind) => {
    const error = thrownBy(() => registerNodeEmitter(kind, emitter));
    expect(error).toBeInstanceOf(QueryError);
    expect(error).toMatchObject({ id: "query.emitterTwice" });
    expect(registeredEmitter(kind)).toBeUndefined();
  });

  test("registers a new kind once and finds it by name", () => {
    expect(registeredEmitter("registryTestKind")).toBeUndefined();
    registerNodeEmitter("registryTestKind", emitter);
    expect(registeredEmitter("registryTestKind")).toBe(emitter);
    expect(thrownBy(() => registerNodeEmitter("registryTestKind", emitter))).toMatchObject({
      id: "query.emitterTwice",
    });
  });

  test("the precedence table, weakest first", () => {
    expect(PRECEDENCE).toStrictEqual({
      fragment: 0,
      or: 1,
      and: 2,
      not: 3,
      is: 4,
      comparison: 5,
      like: 6,
      other: 7,
      additive: 8,
      multiplicative: 9,
      unary: 10,
      atom: 11,
    });
    expect(Object.isFrozen(PRECEDENCE)).toBe(true);
  });
});
