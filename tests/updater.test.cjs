const test = require("node:test");
const assert = require("node:assert/strict");
const UpdateManager = require("../src/updater");

const { isNewer, parseDesignatedRequirement } = UpdateManager._internal;

test("version comparison", () => {
  assert.equal(isNewer("0.3.13", "0.3.12"), true);
  assert.equal(isNewer("v0.4.0", "0.3.99"), true);
  assert.equal(isNewer("0.3.12", "0.3.12"), false);
  assert.equal(isNewer("0.3.11", "0.3.12"), false);
});

test("the running app's designated requirement is read from codesign output", () => {
  const output =
    "Executable=/Applications/SS2.app/Contents/MacOS/SS2\n" +
    'designated => identifier "com.scottfox.scottyspeaks" and certificate root = H"54f4472e8f162e22dee03cb43e9c6d7ad21bc58b"\n';
  assert.equal(
    parseDesignatedRequirement(output),
    'identifier "com.scottfox.scottyspeaks" and certificate root = H"54f4472e8f162e22dee03cb43e9c6d7ad21bc58b"'
  );
  assert.equal(parseDesignatedRequirement("Executable=/x\n"), null);
});

// Runs the real codesign against a system app, so the argument format is proven.
test(
  "downloads are accepted only when signed by the running app's identity",
  { skip: process.platform !== "darwin" },
  async () => {
    const app = "/System/Applications/Calculator.app";
    const manager = new UpdateManager();
    const requirement = await manager.designatedRequirement(app);
    assert.ok(requirement, "read the designated requirement");
    assert.equal(await manager.satisfiesRequirement(app, requirement), true);
    assert.equal(
      await manager.satisfiesRequirement(
        app,
        'identifier "com.scottfox.scottyspeaks" and certificate root = H"0000472e8f162e22dee03cb43e9c6d7ad21bc58b"'
      ),
      false
    );
  }
);
