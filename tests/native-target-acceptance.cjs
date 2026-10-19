// Manual fixture-only acceptance driver. Pair with tests/fixtures/paste-target.swift.
// Commands: capture, verify, paste, replace, release, quit. No user text is read/logged.
const readline = require("node:readline");
const path = require("node:path");
const { RecordingTargetManager } = require("../src/helpers/recordingTarget");
const manager = new RecordingTargetManager({
  binary: process.env.SS2_TARGET_BINARY || path.resolve("resources/bin/macos-recording-target"),
});
let target;
async function main() {
  const input = readline.createInterface({ input: process.stdin });
  console.log(JSON.stringify({ event: "ready", fixtureOnly: true }));
  for await (const line of input) {
    if (line === "quit") { input.close(); break; }
    if (line === "capture") {
      if (target) manager.release(target.token, 999);
      const result = await manager.capture(999);
      target = result.available && result.appName === "SS2 Paste Fixture" ? result : null;
      if (!target && result.token) manager.release(result.token, 999);
      console.log(
        JSON.stringify({
          event: "capture",
          accepted: !!target,
          available: result.available,
          appName: result.appName,
          reason: result.reason,
        })
      );
    } else if (line === "release") {
      if (target) manager.release(target.token, 999);
      target = null;
      console.log(JSON.stringify({ released: true }));
    } else if (!target) console.log(JSON.stringify({ declined: "no-synthetic-target" }));
    else if (line === "verify")
      console.log(JSON.stringify(await manager.verify(target.token, 999)));
    else if (line === "paste" || line === "replace") {
      console.log(
        JSON.stringify(
          await manager.paste(
            target.token,
            999,
            line === "paste"
              ? "SS2 verified synthetic paste."
              : "SS2 verified synthetic replacement.",
            line === "replace" ? "SS2 verified synthetic paste." : undefined
          )
        )
      );
      target = null;
    } else console.log(JSON.stringify({ declined: "unknown-command" }));
  }
}
main()
  .catch(() => {
    console.error("Synthetic acceptance failed");
    process.exitCode = 1;
  })
  .finally(() => manager.close());
