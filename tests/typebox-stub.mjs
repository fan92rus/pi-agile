/**
 * Typebox stub — used ONLY by the test process via typebox-redirect-loader.mjs.
 * Production (pi loading the extension via jiti) never sees this file, so the
 * real @sinclair/typebox keeps validating tool parameters at runtime.
 *
 * The stub is a callable Proxy: any property access (Type.String, Type.Array…)
 * or call (Type.Object({…}), Type.Optional(x)) returns the same callable proxy.
 * Tests only capture tool definitions — they never validate against a schema.
 */
const handler = {
  get(_target, prop) {
    if (prop === Symbol.toPrimitive) return () => "";
    // Return undefined for 'then' so the proxy is not treated as a Promise
    // (awaiting it would hang forever).
    if (prop === "then") return undefined;
    if (typeof prop === "symbol") return undefined;
    return callable;
  },
  apply() {
    return callable;
  },
  construct() {
    return callable;
  },
};

const callable = new Proxy(function typeboxStub() {}, handler);

export const Type = callable;
export const Value = callable;
export const Kind = callable;
export default callable;
