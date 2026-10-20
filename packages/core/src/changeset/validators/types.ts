/**
 * The public types of schema and function validation on changesets: the options of
 * `validate`, and the validators `validateField` takes.
 *
 * @module
 */
import type { ValidatorContext, ValidatorResult } from "../../contracts/changeset.js";
import type { AnySchema } from "../../contracts/schema.js";
import type { StandardSchemaV1 } from "../../contracts/standard-schema.js";
import type { FieldName } from "../types.js";

/**
 * The error key for problems that belong to the record as a whole: an issue with an
 * empty path, or one whose path does not start with a field name.
 *
 * @example
 * ```ts
 * const cs = cast(User, params, ["email"]).validate(() => [{ path: [], message: "is not allowed" }]);
 * cs.errors[BASE]; // [{ message: "is not allowed", validation: "schema", meta: { path: [] } }]
 * ```
 */
export const BASE: "$base" = "$base";

/**
 * Options of `validate` and `validateAsync`.
 *
 * @example
 * ```ts
 * cs.validate(UserInput, { scope: "changed", apply: true, only: ["email", "name"] });
 * ```
 */
export interface ValidateOptions<S = AnySchema> {
  /**
   * Which issues become errors. `"all"` (the default) keeps every issue, so a rule that
   * compares two fields is never dropped because the field it reports on did not change.
   * `"changed"` keeps only issues on fields that have a change, and issues on the record
   * as a whole. Under either scope, an issue on a field that already has an error is
   * dropped: the field keeps its first message.
   */
  readonly scope?: "all" | "changed";
  /**
   * When `true` and the schema finds no issue, write the schema's output back as changes
   * (so that transforms such as `.trim()` take effect). Each value is cast with its
   * field's type first; one the type rejects becomes a `cast` error and is not written.
   * Only a Standard Schema has an output; with a function it throws. It cannot be combined
   * with `only` or `scope: "changed"` (it throws): a schema that reports an issue has no
   * output, even when that issue is then left out. Defaults to `false`.
   */
  readonly apply?: boolean;
  /** Give the validator only these fields, and keep only issues on them (and on the record as a whole). */
  readonly only?: readonly FieldName<S>[];
}

/**
 * A function given to `validateField`: it receives the field's changed value (never
 * `null`) and returns issues whose paths are relative to that value (`[]` for the value
 * itself), or nothing. Any other result, such as a single issue without its array or a
 * string, makes `validateField` throw a `TypeError`.
 *
 * @example
 * ```ts
 * const notExample: FieldValidatorFn<string, FieldValues<typeof User>> = (email) =>
 *   email.endsWith("@example.com") ? [{ path: [], message: "is not allowed" }] : [];
 * cs.validateField("email", notExample);
 * ```
 */
export type FieldValidatorFn<V, T> = (
  value: V,
  ctx: ValidatorContext<T>,
) => ValidatorResult | Promise<ValidatorResult>;

/**
 * What `validateField` takes: a Standard Schema (Zod, Valibot, ArkType, recent Yup) for
 * the field's value, or a {@link FieldValidatorFn}.
 *
 * @example
 * ```ts
 * const email: FieldValidator<string, FieldValues<typeof User>> = z.string().email();
 * ```
 */
export type FieldValidator<V, T> = StandardSchemaV1<unknown, unknown> | FieldValidatorFn<V, T>;
