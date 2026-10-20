/**
 * What nested changes know about an association or an embed field of a changeset's
 * target: a {@link Relation}, computed once per schema (or field table) and name, and the
 * helpers that read a relation's current value and match rows by primary key.
 *
 * @module
 */
import type {
  AnySchema,
  AssocKind,
  AssocMeta,
  FieldMeta,
  OnReplace,
  SchemaMeta,
} from "../../contracts/schema.js";
import { NotLoadedError, QueryError } from "../../errors.js";
import { isPlainObject } from "../../internal/plain-object.js";
import { isRow } from "../../schema/guards.js";
import { meta } from "../../schema/schema.js";
import { embedTypeInfo } from "../../types/embed.js";
import type { Changeset } from "../changeset.js";
import { fieldsOf } from "../changeset.js";
import type { ChangesetSource } from "../types.js";

/** A changeset of any source, as internal code handles it. */
export type AnyChangeset = Changeset<ChangesetSource, boolean>;
export type Values = Readonly<Record<string, unknown>>;

const hasOwn = Object.hasOwn;

/**
 * An association or embed field, as nested changes see it.
 *
 * - `kind`: the association's kind, or `"embed"`.
 * - `many`: whether its value is a list.
 * - `key`: the target's primary-key fields, by which items are matched (empty when the
 *   target has none: then nothing is matched).
 */
export interface Relation {
  readonly name: string;
  /** The owner's class name, for messages. */
  readonly ownerName: string;
  readonly kind: AssocKind | "embed";
  readonly many: boolean;
  readonly onReplace: OnReplace;
  /** The association; `undefined` for an embed. */
  readonly assoc: AssocMeta | undefined;
  /** The embed field; `undefined` for an association. */
  readonly field: FieldMeta | undefined;
  readonly target: AnySchema;
  readonly targetMeta: SchemaMeta;
  readonly key: readonly FieldMeta[];
}

const relations = new WeakMap<object, Map<string, Relation>>();

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/**
 * The relation `name` of a changeset's target: an association (`wanted: "assoc"`) or an
 * embed field (`"embed"`).
 *
 * @throws QueryError when there is no such association or embed, or the association is
 * a has-through one (which is read-only).
 */
export function relationOf(
  changeset: AnyChangeset,
  name: unknown,
  fn: string,
  wanted: "assoc" | "embed",
): Relation {
  const fields = fieldsOf(changeset);
  const model = changeset.model as AnySchema | null;
  const cacheKey: object = model === null ? fields : meta(model);
  let byName = relations.get(cacheKey);
  if (byName === undefined) {
    byName = new Map();
    relations.set(cacheKey, byName);
  }
  if (typeof name !== "string") throw new QueryError(`${fn}() takes the name as a string.`);
  const id = `${wanted}:${name}`;
  const known = byName.get(id);
  if (known !== undefined) return known;
  const relation =
    wanted === "embed" ? embedRelation(fields, model, name, fn) : assocRelation(model, fields, name, fn);
  byName.set(id, relation);
  return relation;
}

function ownerNameOf(model: AnySchema | null): string {
  return model === null ? "this changeset without a schema class" : meta(model).name;
}

function embedRelation(
  fields: ReadonlyMap<string, FieldMeta>,
  model: AnySchema | null,
  name: string,
  fn: string,
): Relation {
  const field = fields.get(name);
  const info = field === undefined ? undefined : embedTypeInfo(field.type);
  if (field === undefined || info === undefined) {
    if (model !== null && meta(model).assocs().has(name)) {
      throw new QueryError(
        `${fn}(): "${name}" is an association of ${meta(model).name}, not an embed. Use ${fn === "castEmbed" ? "castAssoc" : "putAssoc"}("${name}", …).`,
      );
    }
    throw new QueryError(
      field === undefined
        ? `${fn}(): ${ownerNameOf(model)} has no field "${name}".`
        : `${fn}(): "${name}" is not an embed field (it is ${field.type.name}). ${fn} changes fields declared with t.embedOne or t.embedMany; change other fields with ${fn === "castEmbed" ? "cast" : "putChange"}.`,
    );
  }
  const target = info.schema();
  const targetMeta = meta(target);
  return Object.freeze({
    name,
    ownerName: model === null ? "schemaless" : meta(model).name,
    kind: "embed",
    many: info.cardinality === "many",
    onReplace: info.onReplace,
    assoc: undefined,
    field,
    target,
    targetMeta,
    key: targetMeta.primaryKey,
  });
}

function assocRelation(
  model: AnySchema | null,
  fields: ReadonlyMap<string, FieldMeta>,
  name: string,
  fn: string,
): Relation {
  if (model === null) {
    throw new QueryError(`${fn}(): a changeset without a schema class has no associations.`);
  }
  const ownerMeta = meta(model);
  const assoc = ownerMeta.assocs().get(name);
  if (assoc === undefined) {
    const field = fields.get(name);
    if (field !== undefined && embedTypeInfo(field.type) !== undefined) {
      throw new QueryError(
        `${fn}(): "${name}" is an embed field of ${ownerMeta.name}, not an association. Use ${fn === "castAssoc" ? "castEmbed" : "putEmbed"}("${name}", …).`,
      );
    }
    const names = [...ownerMeta.assocs().keys()];
    throw new QueryError(
      `${fn}(): ${ownerMeta.name} has no association "${name}". ${names.length === 0 ? "It has none." : `Its associations are: ${names.join(", ")}.`}`,
    );
  }
  if (assoc.through !== undefined) {
    throw new QueryError(
      `${fn}(): "${name}" of ${ownerMeta.name} is a has-through association, which is read-only. Change the associations it goes through (${assoc.through.join(", ")}) instead.`,
    );
  }
  const target = assoc.target();
  const targetMeta = meta(target);
  return Object.freeze({
    name,
    ownerName: ownerMeta.name,
    kind: assoc.kind,
    many: assoc.kind === "hasMany" || assoc.kind === "manyToMany",
    onReplace: assoc.onReplace,
    assoc,
    field: undefined,
    target,
    targetMeta,
    key: targetMeta.primaryKey,
  });
}

/**
 * The value a relation has before the changes: the rows on the changeset's data (an
 * empty list or `null` for a new record).
 *
 * @throws NotLoadedError when the data is a loaded row whose association was not
 * preloaded as whole rows.
 */
export function currentOf(changeset: AnyChangeset, relation: Relation): readonly object[] {
  const data = changeset.data as Values | null;
  const name = relation.name;
  if (relation.kind === "embed") {
    const value = data === null || !hasOwn(data, name) ? undefined : data[name];
    if (value === undefined || value === null) return NONE;
    return relation.many ? (value as readonly object[]) : [value as object];
  }
  if (data === null) return NONE;
  if (!hasOwn(data, name)) {
    throw new NotLoadedError({ schema: relation.ownerName, association: name });
  }
  const value = data[name];
  const rows = relation.many ? value : value === null ? NONE : [value];
  if (!Array.isArray(rows) || !rows.every((row) => isRow(row))) {
    // Preloaded with a select: plain objects, which nested changes cannot match or write.
    throw new NotLoadedError({ schema: relation.ownerName, association: name });
  }
  return rows as readonly object[];
}

const NONE: readonly object[] = Object.freeze([]);

/**
 * The primary-key values of an item, or `undefined` when one is missing (`undefined`,
 * `null` or `""`). With `cast`, each value is first cast with its field's type (form
 * input); a value the type rejects counts as missing.
 */
export function keyOf(key: readonly FieldMeta[], item: Values, cast: boolean): unknown[] | undefined {
  if (key.length === 0) return undefined;
  const out: unknown[] = [];
  for (const field of key) {
    const value = item[field.name];
    if (value === undefined || value === null || value === "") return undefined;
    if (!cast) {
      out.push(value);
      continue;
    }
    const result = field.type.cast(value);
    if (!result.success) return undefined;
    out.push(result.data);
  }
  return out;
}

function same(field: FieldMeta, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return field.type.equal(a, b);
}

/** The position in `rows` of the row whose key is `values`, or -1. */
export function indexOfKey(
  rows: readonly object[],
  key: readonly FieldMeta[],
  values: readonly unknown[],
): number {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Values;
    let match = true;
    for (let k = 0; k < key.length; k++) {
      const field = key[k] as FieldMeta;
      if (!same(field, row[field.name], values[k])) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** The position in `rows` of the row with the key of `row`, or -1 (always -1 without a key). */
export function indexOfRow(rows: readonly object[], key: readonly FieldMeta[], row: object): number {
  if (key.length === 0) return rows.indexOf(row);
  const values = keyOf(key, row as Values, false);
  return values === undefined ? -1 : indexOfKey(rows, key, values);
}

/**
 * Whether a child changeset takes the row out of the relation: it deletes it (or its
 * link), or (`onReplace: "setNull"`) sets its foreign key to `null`.
 */
export function leaves(relation: Relation, child: AnyChangeset): boolean {
  if (child.action === "delete") return true;
  const assoc = relation.assoc;
  if (assoc === undefined || (assoc.kind !== "hasMany" && assoc.kind !== "hasOne")) return false;
  const changes = child.changes as Values;
  for (const name of assoc.relatedKey) if (!hasOwn(changes, name) || changes[name] !== null) return false;
  return true;
}

/** Whether a value is a plain object (the form of an item of params). */
export function isItem(value: unknown): value is Values {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isPlainObject(value);
}

export { describe };
