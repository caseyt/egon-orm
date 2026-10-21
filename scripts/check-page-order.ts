// Checks that the code of a page reads top to bottom as the files it comes from. A page
// that shows a file in parts (regions of a checked example) must show them so that the
// parts, taken in page order, still compile: a class used before the region that defines it,
// a function or type called above the region that declares it (which the compiler accepts,
// since they are hoisted), or a variable that only exists in code the page does not show,
// fails here, although the example file itself compiles.
//
// For each page of PAGES, the regions it includes are grouped by source file and joined in
// page order; each group is type-checked as a stand-in for its file (so that its relative
// imports still reach the real files beside it). Run by `pnpm lint` (`pnpm docs:check`).
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { regionText, snippetIncludes } from "./check-docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "docs/site");

/** The pages whose code is meant to be followed as files, from the top. */
const PAGES = [
  "guide/getting-started.md",
  "guide/tutorial.md",
  "guide/coming-from-prisma.md",
  "guide/coming-from-drizzle.md",
  "guide/coming-from-sequelize.md",
  ...[
    "auditing",
    "dynamic-filters",
    "enums",
    "find-or-create",
    "form-errors",
    "full-text-search",
    "money",
    "multi-tenancy",
    "optimistic-locking",
    "pagination",
    "soft-deletes",
    "top-n-per-parent",
    "translating-errors",
    "upserts",
  ].map((name) => `recipes/${name}.md`),
];

function compilerOptions(jsx: boolean): ts.CompilerOptions {
  const base = JSON.parse(readFileSync(join(ROOT, "tsconfig.base.json"), "utf8")).compilerOptions;
  const options = ts.convertCompilerOptionsFromJson(base, ROOT).options;
  return {
    ...options,
    baseUrl: ROOT,
    composite: false,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    noEmit: true,
    ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
  };
}

/** The diagnostics of `text`, type-checked as if it were the file at `path`. */
function diagnosticsOf(path: string, text: string): string[] {
  const options = compilerOptions(path.endsWith(".tsx"));
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, onError, shouldCreate) =>
    resolve(fileName) === path
      ? ts.createSourceFile(fileName, text, language, true)
      : original(fileName, language, onError, shouldCreate);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => (resolve(fileName) === path ? text : readFile(fileName));
  const program = ts.createProgram([path], options, host);
  const source = program.getSourceFile(path);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ].map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    return `TS${d.code} at line ${line} of the joined parts: ${message.split("\n")[0]}`;
  });
  return source === undefined
    ? diagnostics
    : [...diagnostics, ...usedBeforeShown(program.getTypeChecker(), source)];
}

/**
 * Names used before the part that declares them. Functions and types are hoisted, so the
 * compiler accepts a call or a type annotation above the declaration; a reader who follows
 * the page does not. A use inside a function body is not counted: it runs when the function
 * is called, which may be after the later declaration.
 */
function usedBeforeShown(checker: ts.TypeChecker, source: ts.SourceFile): string[] {
  const problems: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      // Visit the signature (parameter and return types), not the body.
      for (const child of node.getChildren(source)) if (child !== node.body) visit(child);
      return;
    }
    if (ts.isIdentifier(node)) {
      const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
      if (
        declaration !== undefined &&
        isBinding(declaration) &&
        declaration.getSourceFile() === source &&
        declaration.getStart(source) > node.getStart(source)
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        problems.push(
          `\`${node.text}\` at line ${line} of the joined parts is used before the part that declares it`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/** A name the page declares for the reader: a variable, function, class, type or import, not a property. */
function isBinding(declaration: ts.Declaration): boolean {
  return (
    ts.isVariableDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isInterfaceDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration)
  );
}

function main() {
  const problems: string[] = [];
  for (const page of PAGES) {
    const pagePath = join(SITE, page);
    const markdown = readFileSync(pagePath, "utf8");
    const parts = new Map<string, string[]>();
    for (const include of snippetIncludes(markdown) as { path: string; region?: string }[]) {
      const file = include.path.startsWith("@/")
        ? join(SITE, include.path.slice(2))
        : resolve(dirname(pagePath), include.path);
      if (!/\.tsx?$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      const text = include.region === undefined ? source : regionText(source, include.region);
      if (text === undefined) continue; // check-docs.mjs reports a missing region
      parts.set(file, [...(parts.get(file) ?? []), text]);
    }
    for (const [file, texts] of parts) {
      for (const problem of diagnosticsOf(file, texts.join("\n"))) {
        problems.push(`${page}: ${relative(ROOT, file)}, its parts in page order: ${problem}`);
      }
    }
  }
  if (problems.length > 0) {
    process.stderr.write(
      `check-page-order: ${problems.length} problem(s). A page must show a file's parts so that, read top to bottom, they compile.\n${problems.map((p) => `  ${p}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
