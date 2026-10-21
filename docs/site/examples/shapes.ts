// The checked sources of the type declarations shown in guide/changesets.md,
// guide/constraints.md, guide/repo.md and guide/validation.md. The pages show simplified
// declarations, without `readonly`; outside each region, assignments check that the shown
// type and the library's own agree.
import type * as Egon from "egon-orm";

export function changesetError(real: Egon.ChangesetError) {
  // #region changeset-error
  type ChangesetError = {
    message: string; //                     may contain {placeholders}
    validation?: string; //                 "required", "length", "cast", ...
    constraint?: string; //                 "unique", "foreignKey", ...
    meta: Record<string, unknown>; //       { count: 12, kind: "min" }
  };
  // #endregion changeset-error
  const shown: ChangesetError = real;
  const back: Egon.ChangesetError = shown;
  return back;
}

export function constraintError(): Egon.ChangesetError {
  // #region constraint-error
  const error = {
    message: "has already been taken",
    constraint: "unique",
    meta: { constraint: "unique", constraintName: "users_email_key" },
  };
  // #endregion constraint-error
  return error;
}

export function result<T, E>(real: Egon.Result<T, E>) {
  // #region result
  type Result<T, E> = { success: true; data: T } | { success: false; error: E };
  // #endregion result
  const shown: Result<T, E> = real;
  const back: Egon.Result<T, E> = shown;
  return back;
}

export function validatorFn(
  issue: Egon.ValidationIssue,
  written: (values: Readonly<{ email: string }>) => undefined,
) {
  type Action = Egon.Action;
  // #region validator-fn
  type ValidatorFn<T> = (
    values: Readonly<T>,
    ctx: {
      changes: Readonly<Partial<T>>;
      data: Readonly<T>;
      isChanged(field: keyof T): boolean;
      action: Action | null;
    },
  ) => ValidationIssue[] | undefined | Promise<ValidationIssue[] | undefined>;

  type ValidationIssue = {
    path: PropertyKey | readonly PropertyKey[];
    message: string;
    meta?: Record<string, unknown>;
  };
  // #endregion validator-fn
  const shownIssue: ValidationIssue = issue;
  const backIssue: Egon.ValidationIssue = shownIssue;
  // A function written against the shown type is a validator the library accepts.
  const shown: ValidatorFn<{ email: string }> = (values, ctx) =>
    ctx.isChanged("email") ? [{ path: "email", message: "is taken" }] : written(values);
  const back: Egon.ValidatorFn<{ email: string }> = shown;
  return { back, backIssue };
}
