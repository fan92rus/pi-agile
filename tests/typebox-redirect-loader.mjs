/**
 * Test-process loader hook: redirects the bare specifier "@sinclair/typebox"
 * to the Proxy stub (typebox-stub.mjs). Without this, `import { Type } from
 * "@sinclair/typebox"` in extensions/pi-agile/index.ts fails with
 * ERR_MODULE_NOT_FOUND because typebox lives inside pi's own installation and
 * is not resolvable from plain `node --experimental-strip-types`.
 *
 * Production is unaffected — this hook only exists in the test process.
 */
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stubUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "typebox-stub.mjs"),
).href;

export async function resolve(specifier, context, next) {
  if (specifier === "@sinclair/typebox") {
    return { url: stubUrl, shortCircuit: true };
  }
  return next(specifier, context);
}
