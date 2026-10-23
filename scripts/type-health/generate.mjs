// Generates the synthetic project of the type-health audit (step 21): N schema classes
// (default 200), ten to a file, each with eleven fields, associations to other schemas in
// one of four shapes (`--topology`, see `links`), a changeset function, and per schema a joined, filtered, selected query, a query with a
// named parameter, a preload and an insert. It is a consumer project: `egon-orm` resolves
// to the built declarations (`pnpm build` first), not to the sources.
//
//   node scripts/type-health/generate.mjs [outDir] [--schemas 200] [--topology chain|clusters|tree|hub]
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

/** The topologies: how the schemas' associations link them. */
export const TOPOLOGIES = ["chain", "clusters", "tree", "hub"];

/**
 * The schema that `k` belongs to (`static parent`) and the schemas it has many of (`static
 * children`, `children2`, ...), each by index:
 *
 * - `chain`: `k - 1` and `k + 1`. All schemas are connected, in a path as long as the count.
 * - `clusters`: the chain, cut at file boundaries: ten connected schemas per file.
 * - `tree`: a binary tree, `(k - 1) / 2` and `2k + 1`, `2k + 2`. All connected, depth ~log2(N).
 * - `hub`: every schema belongs to `S000`, which has many of each. All connected, depth 2.
 */
export function links(k, count, topology) {
  if (!TOPOLOGIES.includes(topology)) throw new Error(`unknown topology ${topology}`);
  if (topology === "tree") {
    return {
      parent: k > 0 ? Math.floor((k - 1) / 2) : undefined,
      children: [2 * k + 1, 2 * k + 2].filter((c) => c < count),
    };
  }
  if (topology === "hub") {
    return {
      parent: k > 0 ? 0 : undefined,
      children: k === 0 ? Array.from({ length: count - 1 }, (_, i) => i + 1) : [],
    };
  }
  const sameFile = (other) => topology === "chain" || fileOf(other) === fileOf(k);
  return {
    parent: k > 0 && sameFile(k - 1) ? k - 1 : undefined,
    children: k < count - 1 && sameFile(k + 1) ? [k + 1] : [],
  };
}

/** The number of schemas reachable from schema `k` through associations, `k` included. */
export function reachable(k, count, topology) {
  const seen = new Set([k]);
  const queue = [k];
  while (queue.length > 0) {
    const { parent, children } = links(queue.shift(), count, topology);
    for (const next of parent === undefined ? children : [parent, ...children]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size;
}

const childName = (j) => (j === 0 ? "children" : `children${j + 1}`);

function schemaFile(group, count, topology, variant) {
  const first = group * PER_FILE;
  const last = Math.min(first + PER_FILE, count) - 1;
  const imports = new Map();
  const lines = [];
  for (let k = first; k <= last; k++) {
    const { parent, children } = links(k, count, topology);
    for (const other of parent === undefined ? children : [parent, ...children]) {
      if (fileOf(other) === fileOf(k)) continue;
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
    if (parent !== undefined) {
      const type = variant.annotate ? `: Assoc<"belongsTo", typeof ${name(parent)}, "parentId">` : "";
      lines.push(`  static parent${type} = belongsTo(() => ${name(parent)}, { foreignKey: "parentId" });`);
    }
    children.forEach((c, j) => {
      const type = variant.annotate ? `: Assoc<"hasMany", typeof ${name(c)}, "parentId">` : "";
      lines.push(`  static ${childName(j)}${type} = hasMany(() => ${name(c)}, { foreignKey: "parentId" });`);
    });
    if (variant.noChangeset) {
      lines.push("}\n");
    } else {
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
  }
  const header = [
    `import { ${variant.annotate ? "type Assoc, " : ""}belongsTo, cast, hasMany, Schema, t, timestamps } from "egon-orm";`,
  ];
  for (const [file, names] of [...imports].sort()) {
    header.push(`import { ${[...names].sort().join(", ")} } from "./${file}.js";`);
  }
  return `${header.join("\n")}\n\n${lines.join("\n")}`;
}

function queryFile(group, count, topology, variant) {
  const first = group * PER_FILE;
  const last = Math.min(first + PER_FILE, count) - 1;
  const names = [];
  const lines = [];
  for (let k = first; k <= last; k++) {
    const S = name(k);
    names.push(S);
    const { parent, children } = links(k, count, topology);
    if (parent !== undefined) {
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
    const preload = children.length > 0 ? `.preload("children")` : "";
    lines.push(`export async function use${S}(repo: Repo) {
  const rows = await repo.all(joined${S});
  const adults = await repo.all(named${S}, { minAge: 18 });
  const loaded = await repo.all(from(${S}, "s").where({ active: true })${preload});
  const inserted = await repo.insert(${variant.noChangeset ? `cast(${S}, { name: "a" }, ["name"])` : `${S}.changeset(${S}, { name: "a" })`});
  return { rows, adults, loaded, inserted };
}
`);
  }
  return `import { ${variant.noChangeset ? "cast, " : ""}from, param, type Repo, t } from "egon-orm";
import { ${names.join(", ")} } from "./${fileOf(first)}.js";

${lines.join("\n")}`;
}

/**
 * Writes the project to `outDir`; returns the file that the editor check opens.
 * `variant.annotate` gives every association static an explicit `Assoc<…>` type instead of
 * the type inferred from `hasMany(…)` / `belongsTo(…)`, and `variant.noChangeset` leaves out
 * the `static changeset` methods. Both are diagnostics: what each costs the editor.
 */
export function generate(outDir, count = 200, topology = "chain", variant = {}) {
  rmSync(outDir, { recursive: true, force: true });
  const src = join(outDir, "src");
  mkdirSync(src, { recursive: true });
  const groups = Math.ceil(count / PER_FILE);
  for (let g = 0; g < groups; g++) {
    const id = String(g).padStart(2, "0");
    writeFileSync(join(src, `schemas-${id}.ts`), schemaFile(g, count, topology, variant));
    writeFileSync(join(src, `queries-${id}.ts`), queryFile(g, count, topology, variant));
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
