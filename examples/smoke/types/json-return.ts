// JsonReturn of handlers with declared return types, compiled against the packed packages
// by consumer.mjs in a program of its own, so that nothing checked before it warms
// TypeScript's caches: it must not hit "Type instantiation is excessively deep" (TS2589).
import type { JsonReturn, Loaded } from "egon-orm";
import { belongsTo, Schema, t } from "egon-orm";

export class Author extends Schema("authors", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  passwordHash: t.string().redact(),
  createdAt: t.timestamp(),
}) {}

export class Note extends Schema("notes", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  body: t.string(),
}) {
  static author = belongsTo(() => Author);
}

export declare function me(): Promise<Author>;
export declare function note(): Promise<Loaded<typeof Note, "author">>;
export declare function maybe(): Promise<Loaded<typeof Note, "author"> | null>;
export type Me = JsonReturn<typeof me>;
export type NoteResponse = JsonReturn<typeof note>;
export type MaybeResponse = JsonReturn<typeof maybe>;

export const createdAt: Me["createdAt"] = "2026-10-21T09:00:00.000Z";
export const authorEmail: NoteResponse["author"]["email"] = "ada@example.com";
export const missing: MaybeResponse = null;
