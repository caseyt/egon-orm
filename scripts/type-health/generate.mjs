// Generates the synthetic project of the type-health audit (step 21): N schema classes
// (default 200), ten to a file, each with eleven fields, a `belongsTo` to the one before
// it and a `hasMany` to the one after it (so associations cross files and form a chain;
// `--topology clusters` links only the schemas of one file),
// a changeset function, and per schema a joined, filtered, selected query, a query with a
// named parameter, a preload and an insert. It is a consumer project: `egon-orm` resolves
// to the built declarations (`pnpm build` first), not to the sources.
//
//   node scripts/type-health/generate.mjs [outDir] [--schemas 200] [--topology chain|clusters]
//
// The output is not committed; scripts/type-health/measure.mjs generates it into temp/.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PER_FILE = 10;

/** The name of schema `k`. */
const name = (k) => `S${String(k).padStart(3, "0")}`;
/** The file that declares schema `k`. */
const fileOf = (k) => `schemas-${String(Math.floor(k / PER_FILE)).padStart(2, "0")}`;

/**
 * Whether schema `k` has a parent (`k - 1`) and children (`k + 1`). In the default
 * `chain` topology every schema is linked to its neighbours, so the associations connect
 * all of them; in `clusters` only schemas of the same file are linked (groups of ten).
 */
function links(k, count, topology) {
  const sameFile = (other) => topology === "chain" || fileOf(other) === fileOf(k);
  return { parent: k > 0 && sameFile(k - 1), child: k < count - 1 && sameFile(k + 1) };
}

function schemaFile(group, count, topology) {
  const first = group * PER_FILE;
  const last = Math.min(first + PER_FILE, count) - 1;
  const imports = new Map();
  const lines = [];
  for (let k = first; k <= last; k++) {
    const { parent, child } = links(k, count, topology);
    for (const other of [parent ? k - 1 : -1, child ? k + 1 : -1]) {
      if (other < 0 || fileOf(other) === fileOf(k)) continue;
      const names = imports.get(fileOf(other)) ?? new Set();
      names.add(name(other));
      imports.set(fileOf(other), names);
    }
    const S = name(k);
    lines.push(`export class ${S} extends Schema("t_${k}", {
  id: t.integer().primaryKey().dbGenerated(),
  name: t.string(),
  email: t.string().nullable(),
  age: t.integer().nullable(),
  score: t.float(),
  price: t.decimal({ precision: 10, scale: 2 }),
  active: t.boolean().default(true),
  role: t.enum(["admin", "member", "guest"]).default("member"),
  tags: t.array(t.string()).nullable(),
  parentId: t.integer().nullable(),
  ...timestamps(),
}) {`);
    if (parent) lines.push(`  static parent = belongsTo(() => ${name(k - 1)}, { foreignKey: "parentId" });`);
    if (child) lines.push(`  static children = hasMany(() => ${name(k + 1)}, { foreignKey: "parentId" });`);
    lines.push(`
  static changeset(row: ${S} | typeof ${S}, params: unknown) {
    return cast(row, params, ["name", "email", "age", "role"])
      .validateRequired(["name"])
      .validateLength("name", { max: 100 })
      .validateNumber("age", { greaterThan: 0 });
  }
}
`);
  }
  const header = [`import { belongsTo, cast, hasMany, Schema, t, timestamps } from "egon-orm";`];
  for (const [file, names] of [...imports].sort()) {
    header.push(`import { ${[...names].sort().join(", ")} } from "./${file}.js";`);
  }
  return `${header.join("\n")}\n\n${lines.join("\n")}`;
}

function queryFile(group, count, topology) {
  const first = group * PER_FILE;
  const last = Math.min(first + PER_FILE, count) - 1;
  const names = [];
  const lines = [];
  for (let k = first; k <= last; k++) {
    const S = name(k);
    names.push(S);
    const { parent, child } = links(k, count, topology);
    if (parent) {
      lines.push(`export const joined${S} = from(${S}, "s")
  .joinAssoc("s", "parent", "p")
  .where(({ s, p }) => s.age.gte(18).and(p.name.eq("x")).and(s.active))
  .orderBy(({ s }) => s.createdAt.desc())
  .select(({ s, p }) => ({ id: s.id, name: s.name, parent: p.name, score: s.score }))
  .limit(10);
`);
    } else {
      lines.push(`export const joined${S} = from(${S}, "s")
  .where(({ s }) => s.age.gte(18).and(s.active))
  .select(({ s }) => ({ id: s.id, name: s.name, score: s.score }));
`);
    }
    lines.push(`export const named${S} = from(${S}, "s").where(({ s }) => s.age.gte(param("minAge", t.integer())));
`);
    const preload = child ? `.preload("children")` : "";
    lines.push(`export async function use${S}(repo: Repo) {
  const rows = await repo.all(joined${S});
  const adults = await repo.all(named${S}, { minAge: 18 });
  const loaded = await repo.all(from(${S}, "s").where({ active: true })${preload});
  const inserted = await repo.insert(${S}.changeset(${S}, { name: "a" }));
  return { rows, adults, loaded, inserted };
}
`);
  }
  return `import { from, param, type Repo, t } from "egon-orm";
import { ${names.join(", ")} } from "./${fileOf(first)}.js";

${lines.join("\n")}`;
}

/** Writes the project to `outDir`; returns the file that the editor check opens. */
export function generate(outDir, count = 200, topology = "chain") {
  rmSync(outDir, { recursive: true, force: true });
  const src = join(outDir, "src");
  mkdirSync(src, { recursive: true });
  const groups = Math.ceil(count / PER_FILE);
  for (let g = 0; g < groups; g++) {
    const id = String(g).padStart(2, "0");
    writeFileSync(join(src, `schemas-${id}.ts`), schemaFile(g, count, topology));
    writeFileSync(join(src, `queries-${id}.ts`), queryFile(g, count, topology));
  }
  // The file the editor check works in: a `where` callback with the cursor after `s.`.
  writeFileSync(
    join(src, "where-callback.ts"),
    `import { from } from "egon-orm";
import { ${name(1)} } from "./${fileOf(1)}.js";

export const q = from(${name(1)}, "s")
  .joinAssoc("s", "parent", "p")
  .where(({ s, p }) => s./*cursor*/name.eq(p.name));
`,
  );
  writeFileSync(
    join(outDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: [],
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(outDir, "package.json"),
    `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`,
  );
  // `egon-orm` resolves to the built package, as it does for a user.
  mkdirSync(join(outDir, "node_modules"), { recursive: true });
  symlinkSync(join(ROOT, "packages/core"), join(outDir, "node_modules", "egon-orm"), "dir");
  return join(src, "where-callback.ts");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { schemas: { type: "string", default: "200" }, topology: { type: "string", default: "chain" } },
  });
  const outDir = resolve(positionals[0] ?? "temp/type-health/synthetic");
  generate(outDir, Number(values.schemas), values.topology);
  process.stdout.write(`wrote a ${values.schemas}-schema project (${values.topology}) to ${outDir}\n`);
}
