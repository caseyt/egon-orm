// A TypeDoc plugin for the API reference (docs/site/typedoc.json):
//
// - names each module after the import specifier users write, instead of its path in the
//   repository;
// - fails the run when an exported symbol has no `@example` (TypeDoc's own `notDocumented`
//   validation, an error through `treatWarningsAsErrors`, covers the summary).
import { Converter, ReflectionKind } from "typedoc";

/** Entry file (relative to the repository's `packages/`) -> the import specifier. */
const MODULES = {
  "core/src/index.ts": "egon-orm",
  "core/src/testing.ts": "egon-orm/testing",
  "core/src/migration/index.ts": "egon-orm/migration",
  "postgres/src/index.ts": "@egon-orm/postgres",
  "sqlite/src/index.ts": "@egon-orm/sqlite",
  "mysql/src/index.ts": "@egon-orm/mysql",
  "zod/src/index.ts": "@egon-orm/zod",
  "cli/src/index.ts": "@egon-orm/cli",
};

/** Whether a reflection, or one of its signatures, carries an `@example` block. */
function hasExample(reflection) {
  const comments = [reflection.comment, ...(reflection.signatures ?? []).map((s) => s.comment)];
  if (reflection.type?.declaration?.signatures) {
    comments.push(...reflection.type.declaration.signatures.map((s) => s.comment));
  }
  return comments.some((comment) => comment?.blockTags.some((tag) => tag.tag === "@example"));
}

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const module of context.project.getChildrenByKind(ReflectionKind.Module)) {
      const file = module.sources?.[0]?.fullFileName ?? "";
      const entry = Object.keys(MODULES).find((suffix) => file.endsWith(`/packages/${suffix}`));
      if (entry === undefined) throw new Error(`typedoc-plugin: no module name for ${file}`);
      module.name = MODULES[entry];
    }
  });

  app.converter.on(Converter.EVENT_RESOLVE_END, (context) => {
    for (const module of context.project.getChildrenByKind(ReflectionKind.Module)) {
      for (const exported of module.children ?? []) {
        if (exported.kindOf(ReflectionKind.Reference)) continue; // documented where it is declared
        if (!hasExample(exported)) {
          app.logger.error(
            `${module.name}: the exported ${ReflectionKind.singularString(exported.kind).toLowerCase()} ${exported.name} has no @example in its TSDoc.`,
          );
        }
      }
    }
  });
}
