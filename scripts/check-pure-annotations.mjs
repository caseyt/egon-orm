// Fails when a module of a published package runs code when it loads that a bundler cannot
// prove free of side effects (step 21a). The packages are published unbundled with
// `"sideEffects": false`, so a bundler drops a module nobody uses; but inside a module it
// keeps every top-level statement it cannot prove pure, and with it everything that
// statement refers to. So:
//
// - every call and `new` evaluated when the module loads (in a top-level declaration, or a
//   static field of a top-level class) carries `/* @__PURE__ */`;
// - such a call has no spread among its arguments, nor in the object and array literals it
//   is given: bundlers treat a spread as a possible side effect (a getter, an iterator) and
//   keep the call even when it is annotated;
// - there is no top-level statement that only calls something, except in the `egon`
//   executable (packages/cli/src/bin.ts), which runs the CLI when it is started.
//
// A static block of a class (which hands private access to its module) is allowed: it
// keeps only its own class, which every user of the module needs.
//
// `node scripts/check-pure-annotations.mjs --fix` adds the missing annotations (a spread
// has to be rewritten by hand). Tests, fixtures and code inside functions are not checked.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ts = createRequire(import.meta.url)("typescript");

/** The source trees of the published packages. */
const CHECKED = ["core", "postgres", "mysql", "sqlite", "zod", "cli"].map((name) => `packages/${name}/src`);
/** Files that are not checked: not published (see the tsup configs), or meant to run when loaded. */
const UNPUBLISHED =
  /\.(?:test|test-d|itest)\.ts$|(?:^|\/)test-helpers\.ts$|-fixtures\.ts$|(?:^|\/)sql-cases[^/]*\.ts$|compiler\/advanced\/advanced-(?:cases|queries)\.ts$|^packages\/cli\/src\/bin\.ts$/;

const PURE = /\/\*\s*[@#]__PURE__\s*\*\/\s*$/;

/** Whether the call or `new` at `node` is annotated: the comment right before it. */
function annotated(text, node) {
  return PURE.test(text.slice(Math.max(0, node.getFullStart()), node.getStart()));
}

/**
 * The problems of one module's text, as `{ line, message, fix? }`; `fix` is the position
 * at which to insert the annotation.
 *
 * @param {string} text
 * @param {string} name
 */
export function findInModule(text, name = "module.ts") {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const problems = [];
  const at = (node, message, fix) =>
    problems.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, message, fix });

  /** Walks an expression evaluated at load time, not entering functions or class bodies. */
  const loadTime = (node, insidePure) => {
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      return;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const pure = annotated(text, node);
      if (!pure) at(node, "a call evaluated when the module loads has no /* @__PURE__ */", node.getStart());
      // A call on the result of a call starts where the inner one does, so one annotation
      // cannot cover both: the inner call needs a declaration (or an argument) of its own.
      let callee = node.expression;
      while (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
        callee = callee.expression;
      if (ts.isCallExpression(callee) || ts.isNewExpression(callee)) {
        at(node, "a call on the result of another call cannot have both annotated; split it");
        return;
      }
      // The callee itself (a member access) is not an argument; walk the arguments.
      ts.forEachChild(node.expression, (child) => loadTime(child, insidePure));
      for (const arg of node.arguments ?? []) loadTime(arg, true);
      return;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      at(node, "a tagged template evaluated when the module loads cannot be annotated as pure");
      return;
    }
    if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && insidePure) {
      at(
        node,
        "a spread inside a call evaluated when the module loads keeps the call alive; build the value without it",
      );
    }
    ts.forEachChild(node, (child) => loadTime(child, insidePure));
  };

  for (const statement of sf.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer !== undefined) loadTime(declaration.initializer, false);
      }
    } else if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        const isStatic = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
        if (isStatic && ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
          loadTime(member.initializer, false);
        }
      }
    } else if (ts.isExpressionStatement(statement)) {
      at(
        statement,
        "a top-level statement runs when the module loads; give it no side effect, or move it into a function",
      );
    } else if (ts.isExportAssignment(statement)) {
      loadTime(statement.expression, false);
    }
  }
  return problems;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts") && !UNPUBLISHED.test(relative(root, path))) yield path;
  }
}

/** Every problem in the published sources, as `path:line: message`. With `fix`, adds the annotations. */
export function findProblems(fix = false) {
  const out = [];
  for (const dir of CHECKED) {
    for (const path of sourceFiles(join(root, dir))) {
      let text = readFileSync(path, "utf8");
      const problems = findInModule(text, path);
      const fixable = problems.filter((p) => p.fix !== undefined).sort((a, b) => b.fix - a.fix);
      if (fix && fixable.length > 0) {
        for (const p of fixable) text = `${text.slice(0, p.fix)}/* @__PURE__ */ ${text.slice(p.fix)}`;
        writeFileSync(path, text);
      }
      for (const p of problems) {
        if (!fix || p.fix === undefined) out.push(`${relative(root, path)}:${p.line}: ${p.message}`);
      }
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = findProblems(process.argv.includes("--fix"));
  if (problems.length > 0) {
    console.error(`Code that runs when a module loads must be provably pure:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("ok: every call made when a published module loads is annotated /* @__PURE__ */");
}
