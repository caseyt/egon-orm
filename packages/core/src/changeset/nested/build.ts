/**
 * `buildAssoc`: a changeset for a new child of a parent row, its foreign key already set.
 *
 * @module
 */
import type { AnySchema, AssocKeys, FieldMeta, Row, Target } from "../../contracts/schema.js";
import { QueryError } from "../../errors.js";
import { isRow, isSchema } from "../../schema/guards.js";
import { meta } from "../../schema/schema.js";
import type { Changeset } from "../changeset.js";
import { change } from "../changeset.js";
import type { FieldValues } from "../types.js";
import type { AnyChangeset } from "./relation.js";

/**
 * A changeset for a new record of a `hasOne` or `hasMany` association of `parent`, with
 * the foreign key set from the parent's key (and the association's declared defaults
 * applied) before `values`. Insert it with the repo, or pass it to `putAssoc`.
 *
 * The schema class comes first, as in `assoc` and `isLoaded`: a row's type does not lead
 * back to its class, which is where the associations are declared.
 *
 * @example
 * ```ts
 * const cs = buildAssoc(User, user, "posts", { title: "Hello" }); // Changeset<typeof Post, true>, authorId = user.id
 * await repo.insert(cs);
 * ```
 *
 * @throws QueryError when `parent` is not a row of `schema` with a key, or the association
 * is not a `hasOne` or `hasMany` with a foreign key.
 */
export function buildAssoc<S extends AnySchema, const K extends AssocKeys<S>>(
  schema: S,
  parent: Row<S>,
  name: K,
  values?: Partial<FieldValues<Target<S, K>>>,
): Changeset<Target<S, K>, true> {
  if (!isSchema(schema)) {
    throw new QueryError(
      'buildAssoc() takes the schema class first: buildAssoc(User, user, "posts", { … }).',
    );
  }
  const ownerMeta = meta(schema);
  const assoc = ownerMeta.assocs().get(name);
  if (assoc === undefined) {
    throw new QueryError(`buildAssoc(): ${ownerMeta.name} has no association "${String(name)}".`);
  }
  if ((assoc.kind !== "hasOne" && assoc.kind !== "hasMany") || assoc.through !== undefined) {
    throw new QueryError(
      `buildAssoc(): "${name}" is ${assoc.through !== undefined ? "a has-through" : `a ${assoc.kind}`} association. buildAssoc makes a child of a hasOne or hasMany; for the others, insert the row and use putAssoc.`,
    );
  }
  if (!isRow(parent) || Object.getPrototypeOf(parent) !== schema.prototype) {
    throw new QueryError(`buildAssoc(): the parent must be a ${ownerMeta.name} row.`);
  }
  const target = assoc.target();
  const row = parent as unknown as Readonly<Record<string, unknown>>;
  const keys: Record<string, unknown> = {};
  assoc.relatedKey.forEach((field, i) => {
    const value = row[assoc.ownerKey[i] as string];
    if (value === null || value === undefined) {
      throw new QueryError(
        `buildAssoc(): the ${ownerMeta.name} row has no value for ${(ownerMeta.fieldsByName.get(assoc.ownerKey[i] as string) as FieldMeta).name}, the key the child points at.`,
      );
    }
    keys[field] = value;
  });
  let changeset = change(target as never, { ...assoc.defaults, ...keys } as never) as AnyChangeset;
  if (values !== undefined) changeset = change(changeset as never, values as never) as AnyChangeset;
  return changeset as unknown as Changeset<Target<S, K>, true>;
}
