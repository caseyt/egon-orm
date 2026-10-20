// Writes docs/site/reference/exports.md: every export of every public entry point, with the
// first sentence of its TSDoc and a link to its page in the API reference, grouped by entry
// point and, for `egon-orm`, by topic. The page cannot drift from the code:
//
//   pnpm docs:exports           rewrites the page
//   pnpm docs:exports --check   fails when the committed page differs (run by pnpm lint)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "docs/site/reference/exports.md");

/** The entry points, in page order, and the path of their pages in the API reference. */
const ENTRY_POINTS: readonly { specifier: string; file: string; api: string }[] = [
  { specifier: "egon-orm", file: "packages/core/src/index.ts", api: "egon-orm" },
  { specifier: "egon-orm/testing", file: "packages/core/src/testing.ts", api: "egon-orm/testing" },
  {
    specifier: "egon-orm/migration",
    file: "packages/core/src/migration/index.ts",
    api: "egon-orm/migration",
  },
  { specifier: "@egon-orm/postgres", file: "packages/postgres/src/index.ts", api: "@egon-orm/postgres" },
  { specifier: "@egon-orm/sqlite", file: "packages/sqlite/src/index.ts", api: "@egon-orm/sqlite" },
  { specifier: "@egon-orm/mysql", file: "packages/mysql/src/index.ts", api: "@egon-orm/mysql" },
  { specifier: "@egon-orm/zod", file: "packages/zod/src/index.ts", api: "@egon-orm/zod" },
  { specifier: "@egon-orm/cli", file: "packages/cli/src/index.ts", api: "@egon-orm/cli" },
];

/** Topics of `egon-orm`, by the source path of a declaration (first match wins). */
const TOPICS: readonly { title: string; guide: string; paths: readonly string[] }[] = [
  {
    title: "Schemas and associations",
    guide: "/guide/schemas",
    paths: ["schema/", "contracts/schema.ts", "query/assoc.ts"],
  },
  { title: "Types", guide: "/guide/types", paths: ["types/", "contracts/type.ts"] },
  {
    title: "Changesets and validation",
    guide: "/guide/changesets",
    paths: ["changeset/", "contracts/changeset.ts", "contracts/standard-schema.ts"],
  },
  { title: "Queries and expressions", guide: "/guide/queries", paths: ["query/"] },
  { title: "Repo and results", guide: "/guide/repo", paths: ["repo/", "contracts/result.ts", "compiler/"] },
  { title: "Batch", guide: "/guide/batch", paths: ["batch/"] },
  { title: "Adapters", guide: "/guide/adapters", paths: ["adapter/", "contracts/adapter.ts"] },
  { title: "Errors", guide: "/reference/errors", paths: ["errors.ts"] },
  { title: "The package", guide: "/guide/", paths: ["index.ts"] },
];

type Entry = { name: string; kind: string; folder: string; summary: string; source: string };

function kindOf(declaration: ts.Declaration): { kind: string; folder: string } {
  if (ts.isFunctionDeclaration(declaration)) return { kind: "function", folder: "functions" };
  if (ts.isClassDeclaration(declaration)) return { kind: "class", folder: "classes" };
  if (ts.isInterfaceDeclaration(declaration)) return { kind: "interface", folder: "interfaces" };
  if (ts.isTypeAliasDeclaration(declaration)) return { kind: "type", folder: "type-aliases" };
  return { kind: "constant", folder: "variables" };
}

/** The first sentence of a symbol's TSDoc, on one line, with table pipes escaped. */
function summaryOf(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  const paragraph =
    ts.displayPartsToString(symbol.getDocumentationComment(checker)).split(/\n\s*\n/)[0] ?? "";
  const text = paragraph
    .replace(
      /\{@link\s+([^}|\s]+)(?:\s*\|\s*([^}]+))?\}/g,
      (_, target: string, label?: string) => `\`${label ?? target}\``,
    )
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.*?[.:])(?:\s|$)/.exec(text)?.[1] ?? text;
  return sentence.replace(/:$/, ".").replace(/\|/g, "\\|");
}

function entriesOf(program: ts.Program, file: string): Entry[] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(join(ROOT, file));
  const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`api-index: cannot read ${file}`);
  return checker
    .getExportsOfModule(moduleSymbol)
    .map((exported) => {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declaration = symbol.declarations?.[0];
      if (declaration === undefined) throw new Error(`api-index: ${exported.name} has no declaration`);
      const path = relative(join(ROOT, "packages"), declaration.getSourceFile().fileName);
      // A class exported with `export type { … }` is a type to its users (they never construct
      // it); TypeDoc documents it among the interfaces.
      const specifier = exported.declarations?.[0];
      const typeOnly =
        specifier !== undefined &&
        ts.isExportSpecifier(specifier) &&
        (specifier.isTypeOnly || specifier.parent.parent.isTypeOnly);
      const kind = kindOf(declaration);
      return {
        name: exported.name,
        ...(typeOnly && kind.kind === "class" ? { kind: "class, as a type", folder: "interfaces" } : kind),
        summary: summaryOf(symbol, checker),
        source: path,
      };
    })
    .sort(
      (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.name.localeCompare(b.name),
    );
}

function table(entries: readonly Entry[], api: string): string {
  const rows = entries.map(
    (e) => `| [\`${e.name}\`](/api/reference/${api}/${e.folder}/${e.name}) | ${e.kind} | ${e.summary} |`,
  );
  return ["| Export | Kind | Summary |", "|---|---|---|", ...rows].join("\n");
}

export function render(): string {
  const options: ts.CompilerOptions = {
    ...ts.convertCompilerOptionsFromJson(
      JSON.parse(readFileSync(join(ROOT, "tsconfig.base.json"), "utf8")).compilerOptions,
      ROOT,
    ).options,
    noEmit: true,
    composite: false,
    declaration: false,
  };
  const program = ts.createProgram(
    ENTRY_POINTS.map((e) => join(ROOT, e.file)),
    options,
  );
  const sections: string[] = [];
  for (const entry of ENTRY_POINTS) {
    const entries = entriesOf(program, entry.file);
    sections.push(`## \`${entry.specifier}\``);
    if (entry.specifier !== "egon-orm") {
      sections.push(table(entries, entry.api));
      continue;
    }
    const grouped = new Map<string, Entry[]>();
    for (const e of entries) {
      const inCore = e.source.replace(/^core\/src\//, "");
      const topic = TOPICS.find((t) => t.paths.some((p) => inCore.startsWith(p)));
      if (topic === undefined) throw new Error(`api-index: no topic for ${e.name} (${e.source})`);
      grouped.set(topic.title, [...(grouped.get(topic.title) ?? []), e]);
    }
    for (const topic of TOPICS) {
      const list = grouped.get(topic.title);
      if (list === undefined) continue;
      sections.push(`### ${topic.title}`, `Guide: [${topic.title}](${topic.guide}).`, table(list, entry.api));
    }
  }
  return `<!-- Generated by scripts/api-index.ts from the entry points and their TSDoc. Do not edit: run pnpm docs:exports. -->

# Index of exports

Every function, class, constant and type that the packages export, with the first sentence
of its documentation. Each name links to its page in the [API reference](/api/), which has
the full signature and an example; the guide pages explain how they fit together.

${sections.join("\n\n")}
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const page = render();
  if (process.argv.includes("--check")) {
    if (readFileSync(PAGE, "utf8") !== page) {
      process.stderr.write("docs/site/reference/exports.md is out of date: run pnpm docs:exports\n");
      process.exitCode = 1;
    }
  } else {
    writeFileSync(PAGE, page);
  }
}
