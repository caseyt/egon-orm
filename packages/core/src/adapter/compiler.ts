/**
 * Where the adapter gets its statement compiler from. The compiler and its plan cache
 * belong to `../compiler/`; the adapter owns one compiler per instance, so that the plan
 * cache lives in the adapter and `planCacheSize` is an adapter option.
 *
 * This module is the one seam between the two: `createAdapter` calls
 * {@link createStatementCompiler} once, and the six `compile*` methods of the adapter
 * delegate to what it returns.
 *
 * ## Where each part of a dialect comes from
 *
 * - **Capabilities** (what the database supports) come from the adapter definition, that
 *   is from the dialect package (`POSTGRES_CAPABILITIES` of `@egon-orm/postgres`). They
 *   are the single source: the compiler of an adapter checks features against these and
 *   no other copy. The table in `../compiler/dialect.ts` carries capabilities only for a
 *   compiler made without an adapter (its own tests).
 * - **SQL syntax** (quoting, placeholders, the SQL of operators, functions, lock clauses
 *   and types) comes from the compiler's dialect table for the adapter's `dialect`: SQL
 *   text is written only from the compiler's tables (ADR 0003, rule 1).
 *
 * The two must agree, and that is checked here when the adapter is created: every lock
 * clause the capabilities accept must be one the table can write, and the definition's
 * `quoteIdentifier` must quote as the table does.
 *
 * @module
 */

import {
  type CodecSource,
  createCompiler,
  postgresDialect,
  quoteIdentifier,
  type SqlDialect,
} from "../compiler/index.js";
import type { Adapter, Capabilities, Dialect } from "../contracts/adapter.js";
import { QueryError } from "../errors.js";

/** The part of the {@link Adapter} contract that compiles statements. */
export type StatementCompiler = Pick<
  Adapter,
  "compile" | "compileExplain" | "compileFragment" | "compileInsert" | "compileUpdate" | "compileDelete"
>;

/** What a compiler is created from: one per adapter instance. */
export interface StatementCompilerOptions {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;
  /** Quotes an identifier for the dialect, doubling the quote character. */
  readonly quoteIdentifier: (name: string) => string;
  /** The size of the shape-keyed plan cache. */
  readonly planCacheSize: number;
  /** Where the driver conversions of a type come from: the adapter (its `typeOverrides`). */
  readonly codecs: CodecSource;
}

/** The compiler's SQL syntax table for each dialect that has one (step 17 adds MySQL and SQLite). */
const SYNTAX: Readonly<Partial<Record<Dialect, SqlDialect>>> = Object.freeze({ postgres: postgresDialect });

function unavailable(method: string, dialect: Dialect): never {
  throw new QueryError(
    `adapter.${method}() cannot compile for ${dialect}: this build of egon-orm has no SQL dialect table for it. Run SQL text with adapter.execute() instead.`,
  );
}

/**
 * Creates the statement compiler of one adapter: the compiler of `../compiler/` with the
 * SQL syntax of `options.dialect` and the adapter's own capabilities, and a plan cache of
 * `planCacheSize` shapes. For a dialect the compiler has no table for yet, every
 * `compile*` method throws `QueryError`; execution does not depend on the compiler.
 *
 * @example
 * ```ts
 * const compiler = createStatementCompiler({
 *   dialect: "postgres",
 *   capabilities: POSTGRES_CAPABILITIES,
 *   quoteIdentifier,
 *   planCacheSize: 1000,
 *   codecs: adapter,
 * });
 * ```
 *
 * @throws TypeError when the capabilities accept a lock clause the dialect table cannot
 * write, or `quoteIdentifier` does not quote as the dialect table does.
 */
export function createStatementCompiler(options: StatementCompilerOptions): StatementCompiler {
  const { dialect } = options;
  const syntax = SYNTAX[dialect];
  if (syntax === undefined) {
    return {
      compile: () => unavailable("compile", dialect),
      compileExplain: () => unavailable("compileExplain", dialect),
      compileFragment: () => unavailable("compileFragment", dialect),
      compileInsert: () => unavailable("compileInsert", dialect),
      compileUpdate: () => unavailable("compileUpdate", dialect),
      compileDelete: () => unavailable("compileDelete", dialect),
    };
  }
  for (const clause of options.capabilities.lockModes) {
    if (!Object.hasOwn(syntax.locks, clause)) {
      throw new TypeError(
        `The capabilities of ${dialect} accept the lock clause "${clause}", which its SQL dialect table cannot write.`,
      );
    }
  }
  const probe = 'a"b`c';
  if (options.quoteIdentifier(probe) !== quoteIdentifier(syntax, probe)) {
    throw new TypeError(
      `The adapter's quoteIdentifier does not quote as the ${dialect} SQL dialect table does.`,
    );
  }
  return createCompiler(
    { ...syntax, capabilities: options.capabilities },
    { planCacheSize: options.planCacheSize, codecs: options.codecs },
  );
}
