/**
 * Test-process loader hook (registered via module.register() from
 * smoke.test.mjs): redirects `node:fs` / `fs` imports of the dynamically
 * imported extension modules to fs-spy-wrapper.mjs, which records
 * writeFileSync/renameSync/unlinkSync calls into globalThis.__fsSpy while
 * enabled. The wrapper's own import of the real fs passes through
 * (parentURL guard), so there is no recursion.
 *
 * Production is unaffected — this hook only exists in the test process, and
 * it only changes which module object serves node:fs to the test's own
 * dynamic imports.
 */
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const wrapperUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fs-spy-wrapper.mjs"),
).href;

export async function resolve(specifier, context, next) {
  if (specifier === "node:fs" || specifier === "fs") {
    if (context.parentURL === wrapperUrl) {
      return next(specifier, context); // the wrapper itself imports the real fs
    }
    return { url: wrapperUrl, shortCircuit: true };
  }
  return next(specifier, context);
}
