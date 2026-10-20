/**
 * Nested changesets: the child changesets of associations and embed fields, how they
 * become embedded rows, and `buildAssoc`.
 *
 * This barrel is internal. The `Changeset` methods `castAssoc`, `castEmbed`, `putAssoc`
 * and `putEmbed` delegate here; the repo (`repo/nested.ts`) writes what they record.
 *
 * @module
 */
export { buildAssoc } from "./build.js";
export { castRelation, putRelation } from "./change.js";
export { embedChanges, embedValue, isNestedValue, missingEmbedded } from "./embed.js";
export type { AnyChangeset, Relation } from "./relation.js";
export { currentOf, indexOfRow, leaves, relationOf } from "./relation.js";
