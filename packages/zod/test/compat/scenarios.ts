// The six scenarios every Standard Schema library in the compatibility matrix runs. Each
// library's test file supplies its own schemas for them and calls `runScenarios`.
import { User, UserSettings } from "@egon-orm/test-support";
import type { AnySchema, Changeset, ChangesetSource, Row, StandardSchemaV1, ValidateOptions } from "egon-orm";
import { BASE, cast, meta, Schema, t } from "egon-orm";
import { describe, expect, test } from "vitest";

/** The schemas a library supplies, one per scenario. */
export interface LibrarySchemas {
  /** `{ email: an email address, age: a whole number of at least 13, or null/absent }` */
  readonly signup: StandardSchemaV1;
  /** `{ settings: { theme: "light" | "dark", … } or null }` */
  readonly settings: StandardSchemaV1;
  /** `{ startsAt: Date, endsAt: Date }`, with "must be after start" reported on `endsAt` when it is not later. */
  readonly schedule: StandardSchemaV1;
  /** `{ email: string }`, trimmed and lower-cased in the output. */
  readonly normalizeEmail: StandardSchemaV1;
  /** An email address on its own, for `validateField`. */
  readonly email: StandardSchemaV1;
}

/** A row of `schema` as a query would return it. */
export function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

/** A conference talk: the cross-field fixture. */
export class Talk extends Schema("talks", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  startsAt: t.timestamp(),
  endsAt: t.timestamp(),
}) {}

const joined = new Date("2026-01-10T12:00:00Z");

export function member(settings: UserSettings | null): User {
  return loaded(User, {
    id: 21,
    email: "margaret@apollo.example",
    name: "Margaret",
    role: "member",
    lockVersion: 1,
    createdAt: joined,
    updatedAt: joined,
    settings,
  });
}

export const keynote = (): Talk =>
  loaded(Talk, {
    id: 1,
    title: "Keynote",
    startsAt: new Date("2026-06-01T10:00:00Z"),
    endsAt: new Date("2026-06-01T11:00:00Z"),
  });

type AnyChangeset = Changeset<ChangesetSource, boolean>;

/** How a library's schemas are run: `validate`, or (for an async-only library) `validateAsync`. */
interface Runner {
  validate<C extends AnyChangeset>(cs: C, schema: StandardSchemaV1, options?: ValidateOptions): Promise<C>;
  validateField<C extends AnyChangeset>(cs: C, field: string, schema: StandardSchemaV1): Promise<C>;
}

const sync: Runner = {
  validate: async (cs, schema, options) => cs.validate(schema, options as never),
  validateField: async (cs, field, schema) => cs.validateField(field as never, schema),
};

const async: Runner = {
  validate: (cs, schema, options) => cs.validateAsync(schema, options as never),
  validateField: (cs, field, schema) => cs.validateFieldAsync(field as never, schema),
};

/**
 * Runs the six scenarios. `asyncOnly` is for a library whose Standard Schema always
 * answers with a promise: the scenarios then use `validateAsync`/`validateFieldAsync`,
 * and a check that `validate` refuses it is added.
 */
export function runScenarios(
  library: string,
  schemas: LibrarySchemas,
  options?: { asyncOnly?: boolean },
): void {
  const run = options?.asyncOnly === true ? async : sync;

  describe(`${library}: the compatibility scenarios`, () => {
    test("1. valid input passes and keeps its changes", async () => {
      const cs = await run.validate(
        cast(User, { email: "katherine@nasa.example", age: "34" }, ["email", "age"]),
        schemas.signup,
      );
      expect(cs.errors).toEqual({});
      expect(cs.valid).toBe(true);
      expect(cs.changes).toEqual({ email: "katherine@nasa.example", age: 34 });
    });

    test("2. each issue lands on its field as a schema error", async () => {
      const cs = await run.validate(
        cast(User, { email: "not an address", age: "9" }, ["email", "age"]),
        schemas.signup,
      );
      expect(cs.valid).toBe(false);
      expect(Object.keys(cs.errors).sort()).toEqual(["age", "email"]);
      for (const key of ["age", "email"]) {
        const errors = cs.errors[key] ?? [];
        expect(errors.length).toBeGreaterThan(0);
        for (const error of errors) {
          expect(error.validation).toBe("schema");
          expect(typeof error.message).toBe("string");
          expect(error.meta.path).toEqual([]);
        }
      }
      expect(cs.changes).toEqual({ email: "not an address", age: 9 });
    });

    test("3. a nested path goes to its field, the rest in meta.path", async () => {
      const sepia = loaded(UserSettings, { theme: "sepia", emailNotifications: true });
      const cs = await run.validate(cast(member(sepia), { name: "Maggie" }, ["name"]), schemas.settings);
      expect(Object.keys(cs.errors)).toEqual(["settings"]);
      expect(cs.errors.settings?.[0]?.meta.path).toStrictEqual(["theme"]);
      expect(JSON.parse(JSON.stringify(cs.errors.settings?.[0]?.meta))).toEqual({ path: ["theme"] });
      const fine = cast(member(loaded(UserSettings, { theme: "dark", emailNotifications: false })), {}, []);
      expect((await run.validate(fine, schemas.settings)).valid).toBe(true);
      expect((await run.validate(cast(member(null), {}, []), schemas.settings)).valid).toBe(true);
    });

    test('4. a cross-field rule on an unchanged field is kept by scope "all" and dropped by "changed"', async () => {
      const moved = cast(keynote(), { startsAt: "2026-06-01T12:00:00Z" }, ["startsAt"]);
      const all = await run.validate(moved, schemas.schedule);
      expect(Object.keys(all.errors)).toEqual(["endsAt"]);
      expect(all.errors.endsAt?.[0]?.message).toMatch(/after start/);
      expect(all.errors.endsAt?.[0]?.validation).toBe("schema");
      expect((await run.validate(moved, schemas.schedule, { scope: "changed" })).errors).toEqual({});
      expect((await run.validate(cast(keynote(), {}, []), schemas.schedule)).valid).toBe(true);
    });

    test("5. apply writes the transformed output back as changes", async () => {
      const cs = cast(User, { email: "  Mary@Jackson.Example " }, ["email"]);
      expect((await run.validate(cs, schemas.normalizeEmail, { apply: true })).changes).toEqual({
        email: "mary@jackson.example",
      });
      expect((await run.validate(cs, schemas.normalizeEmail)).changes).toEqual({
        email: "  Mary@Jackson.Example ",
      });
    });

    test("6. validateField checks one changed field, and validateAsync takes the same schemas", async () => {
      const bad = cast(User, { email: "dorothy" }, ["email"]);
      expect(Object.keys((await run.validateField(bad, "email", schemas.email)).errors)).toEqual(["email"]);
      const good = cast(User, { email: "dorothy@vaughan.example" }, ["email"]);
      expect((await run.validateField(good, "email", schemas.email)).valid).toBe(true);
      const checked = await bad.validateAsync(schemas.signup);
      expect(checked.errors.email?.[0]?.validation).toBe("schema");
      expect(Object.hasOwn(checked.errors, BASE)).toBe(false);
    });

    if (options?.asyncOnly === true) {
      test("validate refuses its schemas, which always answer with a promise", () => {
        const cs = cast(User, { email: "a@b.c" }, ["email"]);
        expect(() => cs.validate(schemas.signup)).toThrow(
          "query.validatorPromise: The validator returned a Promise. An async validator runs with validateAsync(); validate() is synchronous. See https://egon-orm.github.io/egon-orm/reference/errors/query#query-validatorpromise",
        );
      });
    }
  });
}
