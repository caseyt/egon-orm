// Writes the pages under docs/site/reference/errors/: every error identifier (ADR 0007) with
// the class that throws it, its short message as the source writes it, and what to do about
// it (the entry of the catalog, packages/core/src/messages/catalog.ts). One page per
// namespace; the identifiers without one are on `general`.
//
//   pnpm docs:errors           rewrites the pages
//   pnpm docs:errors --check   fails when a committed page differs, when an identifier is
//                              thrown without a catalog entry, or when an entry is never
//                              thrown (run by pnpm lint, as part of pnpm docs:check)
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = join(ROOT, "packages/core/src/messages/catalog.ts");
const PAGES = join(ROOT, "docs/site/reference/errors");
const SOURCES = ["core", "postgres", "mysql", "sqlite", "zod", "cli"].map((name) => `packages/${name}/src`);
const UNPUBLISHED =
  /\.(?:test|test-d|itest)\.ts$|(?:^|\/)test-helpers\.ts$|-fixtures\.ts$|(?:^|\/)sql-cases[^/]*\.ts$|compiler\/advanced\/advanced-(?:cases|queries)\.ts$/;
const ID = /^(?:[a-z]+\.[a-zA-Z0-9]+|[a-z][a-zA-Z]+)$/;

/** The classes, by namespace, and what each namespace's page is called. */
const NAMESPACES: Readonly<Record<string, { title: string; classes: string }>> = {
  general: {
    title: "General errors",
    classes:
      "`NoResultsError`, `MultipleResultsError`, `InvalidChangesetError`, `StaleEntryError` and `NotLoadedError`, each with one message",
  },
  query: { title: "Query errors", classes: '`QueryError` (`code: "query"`)' },
  cast: { title: "Cast errors", classes: '`CastError` (`code: "cast"`)' },
  schema: {
    title: "Schema definition errors",
    classes: '`SchemaDefinitionError` (`code: "schemaDefinition"`)',
  },
  constraint: { title: "Constraint errors", classes: '`ConstraintError` (`code: "constraint"`)' },
  database: { title: "Database errors", classes: "`DatabaseError` (its `code` says which kind)" },
  rollback: { title: "Rollback errors", classes: '`RollbackError` (`code: "rollback"`)' },
  migration: {
    title: "Migration errors",
    classes: '`MigrationError` (`code: "migration"`), from `egon-orm/migration`',
  },
};

/** The catalog: identifier to advice, in file order. */
export function readCatalog(): Map<string, string> {
  const sf = ts.createSourceFile(CATALOG, readFileSync(CATALOG, "utf8"), ts.ScriptTarget.Latest, true);
  const out = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) &&
      ts.isStringLiteral(node.initializer)
    ) {
      out.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** How a message expression reads in the docs: its text, with `{name}` for each interpolated value. */
function render(node: ts.Expression | undefined): string {
  if (node === undefined) return "";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) text += `{${label(span.expression)}}${span.literal.text}`;
    return text;
  }
  if (ts.isParenthesizedExpression(node)) return render(node.expression);
  // `details.message ?? "…"`: the default is what the docs can show.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    return render(node.right);
  }
  return `{${label(node)}}`;
}

/**
 * How an interpolated value is shown: the expression as the source writes it (`meta.name`,
 * `describe(value)`), so that two values are never shown alike; a long or branching one
 * (a conditional, a template) is shown as `…`.
 */
function label(node: ts.Expression): string {
  if (ts.isParenthesizedExpression(node)) return label(node.expression);
  const text = node.getText().replace(/\s+/g, " ");
  const simple =
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isAsExpression(node);
  return simple && text.length <= 48 ? text : "…";
}

export interface Site {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  /**
   * The names of the parameters the site passes (`params: { … }`), when they are written
   * out; `undefined` when they come from elsewhere (a variable, another error's).
   */
  readonly params: readonly string[] | undefined;
}

/** The keys of the `params` object literal inside `details`, when both are literals. */
function paramNames(details: ts.Expression | undefined): readonly string[] | undefined {
  if (details === undefined) return [];
  if (!ts.isObjectLiteralExpression(details)) return undefined;
  const params = details.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "params",
  );
  if (params === undefined) {
    // A spread may bring params in from elsewhere.
    return details.properties.some((p) => ts.isSpreadAssignment(p)) ? undefined : [];
  }
  if (!ts.isObjectLiteralExpression(params.initializer)) return undefined;
  const names: string[] = [];
  for (const p of params.initializer.properties) {
    if (ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name))) {
      names.push((p.name as ts.Identifier).text);
    } else {
      return undefined;
    }
  }
  return names;
}

/**
 * Every place a published source names an identifier: a string literal that is an argument
 * of a call or `new` (or a branch of a conditional that is one), or the value of an `id`
 * property; with the message that follows it (the next argument, or the `message`
 * property beside it).
 */
export function findSites(catalog: ReadonlyMap<string, string>): Site[] {
  const sites: Site[] = [];
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  for (const source of SOURCES) {
    for (const path of walk(join(ROOT, source))) {
      const rel = relative(ROOT, path);
      if (!rel.endsWith(".ts") || UNPUBLISHED.test(rel) || path === CATALOG) continue;
      const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const add = (
        literal: ts.StringLiteral,
        message: ts.Expression | undefined,
        params: readonly string[] | undefined,
      ): void => {
        sites.push({
          id: literal.text,
          file: rel,
          line: sf.getLineAndCharacterOfPosition(literal.getStart()).line + 1,
          message: render(message),
          params,
        });
      };
      /** The string literals an argument names: itself, or the branches of a conditional or `??`. */
      const literals = (node: ts.Expression): ts.StringLiteral[] => {
        if (ts.isStringLiteral(node)) return ID.test(node.text) ? [node] : [];
        if (ts.isConditionalExpression(node))
          return [...literals(node.whenTrue), ...literals(node.whenFalse)];
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
          return literals(node.right);
        }
        if (ts.isParenthesizedExpression(node)) return literals(node.expression);
        return [];
      };
      const visit = (node: ts.Node): void => {
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments !== undefined) {
          node.arguments.forEach((arg, i) => {
            for (const literal of literals(arg)) {
              // A dotted string that is no catalog entry counts only where an error is made.
              const makesError =
                ts.isNewExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text.endsWith("Error");
              if (catalog.has(literal.text) || (makesError && /^[a-z]+\.[a-zA-Z0-9]+$/.test(literal.text))) {
                add(literal, node.arguments?.[i + 1], paramNames(node.arguments?.[i + 2]));
              }
            }
          });
        }
        if (ts.isObjectLiteralExpression(node)) {
          for (const property of node.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "id"
            ) {
              const message = node.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "message",
              );
              for (const literal of literals(property.initializer))
                add(literal, message?.initializer, paramNames(node));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  // A literal that names no catalog entry and sits in no error construction is not an
  // identifier (a dotted string passed to some other function); keep only real candidates.
  return sites.filter((site) => catalog.has(site.id) || site.message !== "");
}

const namespaceOf = (id: string): string => (id.includes(".") ? (id.split(".")[0] as string) : "general");
const anchorOf = (id: string): string => id.replace(".", "-").toLowerCase();

/**
 * Escapes text for a Markdown paragraph inside a `v-pre` block. Braces become entities, or
 * a trailing `{…}` would be read as attributes of the paragraph.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/([\\`*_[\]<>|#~])/g, "\\$1")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/** The pages, by file name. */
export function pages(catalog: ReadonlyMap<string, string>, sites: readonly Site[]): Map<string, string> {
  const byNamespace = new Map<string, string[]>();
  for (const id of catalog.keys()) {
    const ns = namespaceOf(id);
    if (!byNamespace.has(ns)) byNamespace.set(ns, []);
    byNamespace.get(ns)?.push(id);
  }
  const out = new Map<string, string>();
  for (const [ns, ids] of byNamespace) {
    const info = NAMESPACES[ns];
    if (info === undefined) throw new Error(`No page title for the namespace "${ns}"; add it to NAMESPACES.`);
    const lines = [
      "<!-- Generated by scripts/error-docs.ts from packages/core/src/messages/catalog.ts and the sources. Do not edit: run pnpm docs:errors. -->",
      "",
      `# ${info.title}`,
      "",
      `Thrown as ${info.classes}. Each entry is an identifier (\`error.id\`), then the message as the`,
      "error states it, where `{expression}` stands for the value of that expression in the source",
      "(`{…}` for one too long to show), then what to do about it: the text `useFullErrorMessages(messages)`",
      "and `explain(error)` add, where `{name}` stands for the error's parameter of that name.",
      "See [Errors](/reference/errors).",
      "",
      "::: v-pre",
      "",
    ];
    for (const id of [...ids].sort()) {
      const messages = [
        ...new Set(sites.filter((site) => site.id === id).map((site) => site.message)),
      ].filter((message) => message !== "");
      lines.push(`## \`${id}\` {#${anchorOf(id)}}`, "");
      for (const message of messages) lines.push(`> ${escapeMarkdown(message).replace(/\n+/g, " ")}`, "");
      lines.push(
        escapeMarkdown((catalog.get(id) ?? "").replace(/\{\{(\w+)\}\}/g, "{$1}")).replace(/\n/g, " "),
        "",
      );
    }
    lines.push(":::", "");
    out.set(`${ns}.md`, lines.join("\n"));
  }
  return out;
}

/** What is wrong between the code and the catalog. */
export function problems(catalog: ReadonlyMap<string, string>, sites: readonly Site[]): string[] {
  const out: string[] = [];
  const thrown = new Set(sites.map((site) => site.id));
  for (const site of sites) {
    const advice = catalog.get(site.id);
    if (advice === undefined) {
      out.push(`${site.file}:${site.line}: "${site.id}" has no entry in the catalog`);
      continue;
    }
    // Every {{name}} of the entry must be passed, or the full text shows it unfilled.
    if (site.params !== undefined) {
      for (const [, name] of advice.matchAll(/\{\{(\w+)\}\}/g)) {
        if (!site.params.includes(name as string)) {
          out.push(
            `${site.file}:${site.line}: "${site.id}" passes no parameter "${name}", which its catalog entry names`,
          );
        }
      }
    }
  }
  for (const [id, advice] of catalog) {
    if (!thrown.has(id)) out.push(`catalog: "${id}" is thrown nowhere`);
    if (advice.trim() === "") out.push(`catalog: "${id}" says nothing to do`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const catalog = readCatalog();
  const sites = findSites(catalog);
  const errors = problems(catalog, sites);
  const written = pages(catalog, sites);
  if (check) {
    for (const [name, text] of written) {
      const path = join(PAGES, name);
      if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
        errors.push(`docs/site/reference/errors/${name} is out of date: run pnpm docs:errors`);
      }
    }
    if (existsSync(PAGES)) {
      for (const name of readdirSync(PAGES)) {
        if (!written.has(name))
          errors.push(`docs/site/reference/errors/${name} documents no namespace: remove it`);
      }
    }
  } else {
    if (existsSync(PAGES)) rmSync(PAGES, { recursive: true });
    mkdirSync(PAGES, { recursive: true });
    for (const [name, text] of written) writeFileSync(join(PAGES, name), text);
  }
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log(
    check
      ? `ok: ${catalog.size} error identifiers, each thrown and documented`
      : `wrote ${written.size} pages, ${catalog.size} identifiers`,
  );
}
