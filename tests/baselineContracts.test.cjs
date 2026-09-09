const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function loadTypeScriptModule(relativePath) {
  const filename = path.resolve(__dirname, "..", relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(output, filename);
  return loaded.exports;
}

const auth = loadTypeScriptModule("src/lib/neonAuth.ts");
const { useUsage } = loadTypeScriptModule("src/hooks/useUsage.ts");

test("withSessionRefresh invokes an async operation and returns its resolved value", async () => {
  let calls = 0;

  const result = await auth.withSessionRefresh(async () => {
    calls += 1;
    return { success: true, text: "transcribed" };
  });

  assert.deepEqual(result, { success: true, text: "transcribed" });
  assert.equal(calls, 1);
});

test("withSessionRefresh preserves operation failures", async () => {
  const failure = new Error("cloud unavailable");

  await assert.rejects(
    async () => await auth.withSessionRefresh(async () => Promise.reject(failure)),
    failure
  );
});

test("disabled authentication operations return an explicit unavailable result", async () => {
  const social = await auth.signInWithSocial("google");
  const reset = await auth.resetPassword("password123", "token");
  const request = await auth.requestPasswordReset("person@example.com");

  for (const result of [social, reset, request]) {
    assert.equal(result.data, null);
    assert.match(result.error.message, /not available/i);
  }
});

test("local usage exposes the complete unlimited contract", async () => {
  const usage = useUsage();

  assert.equal(usage.plan, "local");
  assert.equal(usage.hasLoaded, true);
  assert.equal(usage.isOverLimit, false);
  assert.equal(usage.isApproachingLimit, false);
  assert.equal(usage.checkoutLoading, false);
  assert.equal(usage.limit, Infinity);
  assert.equal(typeof usage.openBillingPortal, "function");

  const checkout = await usage.openCheckout("annual");
  const billing = await usage.openBillingPortal();
  assert.deepEqual(checkout, {
    success: false,
    error: "Subscriptions are not available in this local-only build.",
  });
  assert.deepEqual(billing, checkout);
});
