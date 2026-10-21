/**
 * Where the adapter gets its statement compiler from. The compiler and its plan cache
 * belong to `../compiler/`; `planCacheSize` is an adapter option.
 *
 * This module is the one seam between the two: `createAdapter` calls
 * {@link sharedStatementCompiler} once, and the six `compile*` methods of the adapter
 * delegate to what it returns.
 *
 * ## One plan cache per configuration
 *
 * A compiled plan depends only on the dialect, the capabilities, the driver's codecs and
 * the cache's size, never on the adapter instance (its pool, its connection settings). So
 * every adapter created with the same four shares one compiler and its plan cache: a repo
 * (and its adapter) created per request, as on Cloudflare Workers, reuses the plans
 * compiled by earlier requests. The capabilities and codecs are compared by identity,
 * which is how the dialect packages pass them (module-level constants); the number of
 * shared compilers is the number of configurations in use, and each one is bounded by its
 * `planCacheSize`.
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
  mysqlDialect,
  type PlanCacheStats,
  postgresDialect,
  quoteIdentifier,
  type SqlDialect,
  sqliteDialect,
} from "../compiler/index.js";
import type { Adapter, Capabilities, Dialect } from "../contracts/adapter.js";
import type { AnyFieldType, Codec } from "../contracts/type.js";
import { QueryError } from "../errors.js";
import { type DriverCodecs, typeOverridesFrom } from "./codecs.js";

/** The part of the {@link Adapter} contract that compiles statements, and the plan cache's counters. */
export type StatementCompiler = Pick<
  Adapter,
  "compile" | "compileExplain" | "compileFragment" | "compileInsert" | "compileUpdate" | "compileDelete"
> & {
  /** The plan cache's counters (all zero for a dialect without a SQL table). */
  stats(): PlanCacheStats;
};

/** The counters of a compiler that never caches anything. */
const NO_STATS: PlanCacheStats = /* @__PURE__ */ Object.freeze({
  hits: 0,
  misses: 0,
  collisions: 0,
  size: 0,
});

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

/** The compiler's SQL syntax table for each dialect. */
const SYNTAX: Readonly<Partial<Record<Dialect, SqlDialect>>> = /* @__PURE__ */ Object.freeze({
  postgres: postgresDialect,
  mysql: mysqlDialect,
  sqlite: sqliteDialect,
});

/**
 * The compiler's SQL table for `dialect`, or `undefined` when this build has none. For the
 * repo, which needs a dialect value that is not a capability (the identifier limit).
 *
 * @example
 * ```ts
 * sqlDialectOf("postgres")?.identifierMaxBytes; // 63
 * ```
 */
export function sqlDialectOf(dialect: Dialect): SqlDialect | undefined {
  return SYNTAX[dialect];
}

function unavailable(method: string, dialect: Dialect): never {
  throw new QueryError(
    "query.noDialectTable",
    `adapter.${method}() cannot compile for ${dialect}: this build of egon-orm has no SQL dialect table for it.`,
  );
}

/** Checks that a definition agrees with its dialect's SQL table (see the module comment). */
function checkAgainst(
  syntax: SqlDialect,
  options: Pick<StatementCompilerOptions, "dialect" | "capabilities" | "quoteIdentifier">,
): void {
  const { dialect } = options;
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
}

/** {@link checkAgainst} for a definition whose dialect may have no SQL table (nothing to check then). */
function checkDefinition(
  options: Pick<StatementCompilerOptions, "dialect" | "capabilities" | "quoteIdentifier">,
): void {
  const syntax = SYNTAX[options.dialect];
  if (syntax !== undefined) checkAgainst(syntax, options);
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
      stats: () => NO_STATS,
    };
  }
  checkAgainst(syntax, options);
  return createCompiler(
    { ...syntax, capabilities: options.capabilities },
    { planCacheSize: options.planCacheSize, codecs: options.codecs },
  );
}

/** What {@link sharedStatementCompiler} needs: the parts of an adapter definition a plan depends on. */
export interface SharedCompilerOptions {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;
  readonly quoteIdentifier: (name: string) => string;
  readonly planCacheSize: number;
  readonly driverCodecs: DriverCodecs;
}

/** A compiler shared by every adapter of one configuration, and the type conversions its plans were built with. */
export interface SharedCompiler {
  readonly compiler: StatementCompiler;
  /** The adapter's `typeOverrides`: one function per configuration, so that every sharing adapter converts alike. */
  readonly typeOverrides: (type: AnyFieldType) => Codec | undefined;
}

/** dialect -> capabilities -> driver codecs -> plan cache size -> the shared compiler. */
const SHARED = /* @__PURE__ */ new Map<
  Dialect,
  WeakMap<Capabilities, WeakMap<DriverCodecs, Map<number, SharedCompiler>>>
>();

/**
 * The statement compiler of an adapter: shared with every adapter created with the same
 * dialect, capabilities, driver codecs and `planCacheSize`, so that its plan cache
 * outlives the adapter. The definition is checked against the dialect's SQL table every
 * time, as {@link createStatementCompiler} checks it.
 *
 * @example
 * ```ts
 * const { compiler, typeOverrides } = sharedStatementCompiler({
 *   dialect: "postgres",
 *   capabilities: POSTGRES_CAPABILITIES,
 *   quoteIdentifier,
 *   planCacheSize: 1000,
 *   driverCodecs: PG_DRIVER_CODECS,
 * });
 * ```
 *
 * @throws TypeError as {@link createStatementCompiler} does.
 */
export function sharedStatementCompiler(options: SharedCompilerOptions): SharedCompiler {
  let byCapabilities = SHARED.get(options.dialect);
  if (byCapabilities === undefined) {
    byCapabilities = new WeakMap();
    SHARED.set(options.dialect, byCapabilities);
  }
  let byCodecs = byCapabilities.get(options.capabilities);
  if (byCodecs === undefined) {
    byCodecs = new WeakMap();
    byCapabilities.set(options.capabilities, byCodecs);
  }
  let bySize = byCodecs.get(options.driverCodecs);
  if (bySize === undefined) {
    bySize = new Map();
    byCodecs.set(options.driverCodecs, bySize);
  }
  const found = bySize.get(options.planCacheSize);
  if (found !== undefined) {
    checkDefinition(options);
    return found;
  }
  const typeOverrides = typeOverridesFrom(options.driverCodecs);
  const compiler = createStatementCompiler({
    dialect: options.dialect,
    capabilities: options.capabilities,
    quoteIdentifier: options.quoteIdentifier,
    planCacheSize: options.planCacheSize,
    codecs: { typeOverrides },
  });
  const shared: SharedCompiler = { compiler, typeOverrides };
  bySize.set(options.planCacheSize, shared);
  return shared;
}
