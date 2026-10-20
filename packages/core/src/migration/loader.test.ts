// Defining migrations, parsing versions, and loading them from a directory or a list.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isEgonError, MigrationError } from "../errors.js";
import { defineMigration, isMigration } from "./define.js";
import { checkVersion, loadMigrations, migrationList, parseMigrationFileName } from "./loader.js";

const noop = defineMigration({ up() {}, down() {} });

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("defineMigration", () => {
  test("takes up and down; transaction defaults to true", () => {
    const migration = defineMigration({ up() {}, down() {} });
    expect(isMigration(migration)).toBe(true);
    expect(migration.transaction).toBe(true);
    expect(typeof migration.up).toBe("function");
    expect(typeof migration.down).toBe("function");
    expect(Object.keys(migration)).toEqual(["up", "down", "transaction"]);
    const outside = defineMigration({ up() {}, down() {}, transaction: false });
    expect(outside.transaction).toBe(false);
    expect(Object.isFrozen(outside)).toBe(true);
  });

  test.each<[string, unknown, string]>([
    ["up alone", { up() {} }, "defineMigration() was given no down()."],
    ["down alone", { down() {} }, "defineMigration() was given no up()."],
    ["an empty object", {}, "defineMigration() was given no up() and no down()."],
    ["an undefined down", { up() {}, down: undefined }, "defineMigration() was given no down()."],
  ])("refuses %s with a MigrationError that names the missing function", (_name, definition, start) => {
    const error = thrown(() => defineMigration(definition as never));
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toBe(
      `${start} A migration has both up(m) and down(m); when there is nothing to undo, write down() {} with a // noop comment.`,
    );
  });

  test("change() is refused, with the way to write it as up and down", () => {
    const alone = thrown(() => defineMigration({ change() {} } as never));
    expect(alone).toBeInstanceOf(MigrationError);
    expect((alone as Error).message).toBe(
      "defineMigration() was given no up() and no down(). change() is not supported: write the change in up(m) and what undoes it in down(m).",
    );
    const beside = thrown(() => defineMigration({ change() {}, up() {}, down() {} } as never));
    expect(beside).toBeInstanceOf(TypeError);
    expect((beside as Error).message).toMatch(/unknown key "change".*change\(\) is not supported/);
  });

  test.each<[string, unknown]>([
    ["nothing", undefined],
    ["a function", () => {}],
    ["an unknown key", { up() {}, down() {}, lock: true }],
    ["an up that is not a function", { up: "create table", down() {} }],
    ["a down that is not a function", { up() {}, down: "drop table" }],
    ["a transaction that is not a boolean", { up() {}, down() {}, transaction: "no" }],
  ])("refuses %s with a TypeError", (_name, definition) => {
    expect(() => defineMigration(definition as never)).toThrow(TypeError);
  });

  test("isMigration recognises only what defineMigration made", () => {
    expect(isMigration({ up() {}, down() {}, transaction: true })).toBe(false);
    expect(isMigration(null)).toBe(false);
    expect(isMigration("x")).toBe(false);
  });
});

describe("versions", () => {
  test("a file name is a 14-digit version, an underscore, a name and an extension", () => {
    expect(parseMigrationFileName("20261012093000_create_users.ts")).toEqual({
      version: 20261012093000,
      name: "create_users",
    });
    for (const extension of ["mts", "js", "mjs"]) {
      expect(parseMigrationFileName(`20261012093000_a.${extension}`)?.name).toBe("a");
    }
  });

  test("other files are not migrations", () => {
    for (const file of [
      "README.md",
      "helpers.ts",
      "20261012093000_types.d.ts",
      "20261012093000-x.ts",
      "x_20261012093000.ts",
    ]) {
      expect(parseMigrationFileName(file)).toBeUndefined();
    }
  });

  test("a version that is not 14 digits is refused with the fix", () => {
    expect(() => parseMigrationFileName("2026101209_create_users.ts")).toThrow(
      /does not start with a 14-digit version .* "20261012093000_create_users\.ts"/,
    );
  });

  test("checkVersion takes positive safe integers only", () => {
    expect(checkVersion("x", 1)).toBe(1);
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "20261012093000", undefined]) {
      expect(() => checkVersion("x", bad)).toThrow(TypeError);
    }
  });
});

describe("an in-memory list", () => {
  test("is sorted by version", () => {
    const list = migrationList([
      { version: 20260301000000, name: "third", migration: noop },
      { version: 20260101000000, name: "first", migration: noop },
      { version: 20260201000000, name: "second", migration: noop },
    ]);
    expect(list.map((source) => source.name)).toEqual(["first", "second", "third"]);
  });

  test("refuses duplicate versions, bad names, bad versions and plain objects", () => {
    expect(() =>
      migrationList([
        { version: 20260101000000, name: "a", migration: noop },
        { version: 20260101000000, name: "b", migration: noop },
      ]),
    ).toThrow(/Two migrations have the version 20260101000000: "a" and "b"/);
    expect(() => migrationList([{ version: 20260101000000, name: "a-b", migration: noop }])).toThrow(
      TypeError,
    );
    expect(() => migrationList([{ version: "1", name: "a", migration: noop }])).toThrow(TypeError);
    expect(() => migrationList([{ version: 1, name: "a", migration: { up() {}, down() {} } }])).toThrow(
      TypeError,
    );
    expect(() => migrationList([null])).toThrow(TypeError);
    expect(() => migrationList("x" as never)).toThrow(TypeError);
  });

  test("refuses a migration without up or down that defineMigration did not make, naming it", () => {
    // As made by another copy of the package, or forged: the mark without the functions.
    const forged = { [Symbol.for("egon.migration")]: true, up() {}, down: undefined, transaction: true };
    const error = thrown(() =>
      migrationList([{ version: 20260101000000, name: "add_age", migration: forged }]),
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).message).toMatch(/^The migration "add_age" has no down\(\)\./);
    expect((error as MigrationError).version).toBe(20260101000000);
    expect((error as MigrationError).migration).toBe("add_age");
  });
});

describe("a directory", () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "egon-migrations-"));
    const body = (exportAs: string): string =>
      `const migration = { [Symbol.for("egon.migration")]: true, up: () => {}, down: () => {}, transaction: true };\n${exportAs}\n`;
    await writeFile(join(directory, "20260201000000_second.mjs"), body("export default migration;"));
    await writeFile(join(directory, "20260101000000_first.mjs"), body("export { migration };"));
    await writeFile(join(directory, "README.md"), "not a migration");
    await writeFile(join(directory, "helpers.mjs"), "export const x = 1;");
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("loads the default export or the export named migration, in version order, ignoring other files", async () => {
    const sources = await loadMigrations(directory);
    expect(sources.map((source) => [source.version, source.name])).toEqual([
      [20260101000000, "first"],
      [20260201000000, "second"],
    ]);
    expect(sources.every((source) => isMigration(source.migration))).toBe(true);
  });

  test("a file that exports no migration is refused", async () => {
    const error = await loadMigrations(directory, async () => ({ default: { up() {}, down() {} } })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).message).toMatch(/exports no migration/);
    expect((error as MigrationError).version).toBe(20260101000000);
  });

  test("a file whose defineMigration() has no down is refused, naming the file and the function", async () => {
    const error = await loadMigrations(directory, async () => ({
      default: defineMigration({ up() {} } as never),
    })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    const message = (error as MigrationError).message;
    expect(message).toMatch(/^Cannot load the migration file ".*20260101000000_first\.mjs": /);
    expect(message).toMatch(
      /defineMigration\(\) was given no down\(\)\. .*down\(\) \{\} with a \/\/ noop comment/,
    );
    expect((error as MigrationError).version).toBe(20260101000000);
    expect((error as MigrationError).migration).toBe("first");
    expect((error as Error).cause).toBeInstanceOf(MigrationError);
  });

  test("a real file without up is refused when it is imported, naming the file", async () => {
    const own = await mkdtemp(join(tmpdir(), "egon-migrations-noup-"));
    try {
      const define = pathToFileURL(join(import.meta.dirname, "define.ts")).href;
      await writeFile(
        join(own, "20260301000000_no_up.mts"),
        `import { defineMigration } from ${JSON.stringify(define)};\nexport default defineMigration({ down() {} });\n`,
      );
      const error = await loadMigrations(own).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as Error).message).toMatch(
        /^Cannot load the migration file ".*20260301000000_no_up\.mts": defineMigration\(\) was given no up\(\)\./,
      );
      expect((error as MigrationError).version).toBe(20260301000000);
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  });

  test("a file exporting a migration without down that defineMigration did not make is refused", async () => {
    const forged = { [Symbol.for("egon.migration")]: true, change() {}, up: undefined, down: undefined };
    const error = await loadMigrations(directory, async () => ({ default: forged })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(
      /^The migration file ".*20260101000000_first\.mjs" has no up\(\) and no down\(\)\. change\(\) is not supported/,
    );
    expect((error as MigrationError).version).toBe(20260101000000);
  });

  test("a TypeScript file without a TypeScript loader gets an explanation of what to install", async () => {
    const tsDirectory = await mkdtemp(join(tmpdir(), "egon-migrations-ts-"));
    try {
      await writeFile(join(tsDirectory, "20260101000000_first.ts"), "export {};");
      const unknownExtension = Object.assign(new TypeError('Unknown file extension ".ts"'), {
        code: "ERR_UNKNOWN_FILE_EXTENSION",
      });
      const error = await loadMigrations(tsDirectory, () => Promise.reject(unknownExtension)).catch(
        (e: unknown) => e,
      );
      expect(isEgonError(error, "migration")).toBe(true);
      expect((error as Error).message).toMatch(/no TypeScript loader.*Node 22\.18.*tsx.*Bun/);
      expect((error as Error).cause).toBe(unknownExtension);
    } finally {
      await rm(tsDirectory, { recursive: true, force: true });
    }
  });

  test("any other load failure keeps its cause", async () => {
    const failure = new SyntaxError("Unexpected token");
    const error = await loadMigrations(directory, () => Promise.reject(failure)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toMatch(/Cannot load the migration file/);
    expect((error as Error).cause).toBe(failure);
  });

  test("a directory that cannot be read, or no directory at all, is refused", async () => {
    await expect(loadMigrations(join(directory, "missing"))).rejects.toThrow(
      /Cannot read the migrations directory/,
    );
    await expect(loadMigrations("")).rejects.toThrow(TypeError);
  });

  test("two files with one version are refused", async () => {
    const duplicates = await mkdtemp(join(tmpdir(), "egon-migrations-dup-"));
    try {
      await writeFile(join(duplicates, "20260101000000_a.mjs"), "export {};");
      await writeFile(join(duplicates, "20260101000000_b.mjs"), "export {};");
      const error = await loadMigrations(duplicates, async () => ({ migration: noop })).catch(
        (e: unknown) => e,
      );
      expect((error as Error).message).toMatch(/Two migrations have the version 20260101000000/);
    } finally {
      await rm(duplicates, { recursive: true, force: true });
    }
  });
});
