/**
 * The options of `sqlite(...)`, checked.
 *
 * @module
 */

/** A pragma's value: a word or number, or a boolean (written `ON` / `OFF`). */
export type PragmaValue = string | number | boolean;

/**
 * The options of {@link sqlite}. Every option may also be given as `undefined`, which is
 * the same as leaving it out.
 *
 * @example
 * ```ts
 * const options: SqliteOptions = {
 *   filename: "app.db",
 *   pragmas: { journal_mode: "WAL", busy_timeout: 5000 },
 * };
 * ```
 */
export interface SqliteOptions {
  /** The database file, or `":memory:"` for a database that lives as long as the adapter. */
  readonly filename: string;
  /**
   * Pragmas run, in order, when the database is opened (`pragma journal_mode = WAL`).
   * `foreign_keys` is `ON` unless it is given here.
   */
  readonly pragmas?: Readonly<Record<string, PragmaValue>> | undefined;
  /** Opens the file read-only. Default `false`. */
  readonly readonly?: boolean | undefined;
  /** How many compiled query shapes the adapter keeps. Default 1,000. */
  readonly planCacheSize?: number | undefined;
}

/** What the driver needs to open the database. */
export interface OpenSettings {
  readonly filename: string;
  readonly readonly: boolean;
  /** The pragma statements, in order, with `foreign_keys = ON` first unless the options set it. */
  readonly pragmas: readonly string[];
}

const OPTION_KEYS: ReadonlySet<string> = new Set(["filename", "pragmas", "readonly", "planCacheSize"]);

/** A pragma's name: letters and underscores, as SQLite names them. */
const PRAGMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A pragma's value as a word or a number: no quotes, spaces or punctuation besides `.` and `-`. */
const PRAGMA_WORD = /^-?[A-Za-z0-9_.]+$/;

function fail(message: string): never {
  throw new TypeError(`sqlite(options): ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The text of one pragma statement. Pragmas take no bound parameters, so the name and the
 * value are checked to be a plain name and a plain word or number before they are written.
 */
function pragmaStatement(name: string, value: unknown): string {
  if (!PRAGMA_NAME.test(name)) fail(`the pragma name ${JSON.stringify(name)} is not a plain name.`);
  let text: string;
  if (typeof value === "boolean") text = value ? "ON" : "OFF";
  else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  else if (typeof value === "string" && PRAGMA_WORD.test(value)) text = value;
  else {
    return fail(
      `the pragma ${name} must be a word, a number or a boolean (letters, digits, "_", "." and "-" only).`,
    );
  }
  return `pragma ${name} = ${text}`;
}

/**
 * Checks the options and makes the settings the driver opens the database with.
 *
 * @throws TypeError for an unknown option, a missing or empty `filename`, or a pragma that
 * is not a plain name with a plain value.
 */
export function resolveOptions(options: SqliteOptions | undefined): OpenSettings {
  if (!isPlainObject(options)) fail('options must be a plain object, such as { filename: ":memory:" }.');
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.has(key)) {
      fail(`unknown option ${JSON.stringify(key)}. The options are: ${[...OPTION_KEYS].join(", ")}.`);
    }
  }
  const filename: unknown = options.filename;
  if (typeof filename !== "string" || filename === "" || filename.includes("\u0000")) {
    fail('filename must be a non-empty string: a file name, or ":memory:".');
  }
  const readonly: unknown = options.readonly;
  if (readonly !== undefined && typeof readonly !== "boolean") fail("readonly must be a boolean.");
  const given: unknown = options.pragmas;
  if (given !== undefined && !isPlainObject(given)) {
    fail('pragmas must be an object of pragma names and values, such as { journal_mode: "WAL" }.');
  }
  const pragmas: string[] = [];
  const entries = given === undefined ? [] : Object.entries(given);
  // Foreign keys are on unless the options say otherwise (SQLite's own default is off).
  if (!entries.some(([name]) => name.toLowerCase() === "foreign_keys"))
    pragmas.push("pragma foreign_keys = ON");
  for (const [name, value] of entries) {
    if (value === undefined) continue;
    pragmas.push(pragmaStatement(name, value));
  }
  return { filename, readonly: readonly === true, pragmas };
}
