// Regression tests for the Nov 9 2026 demo failures: a call recording that
// auto-stopped during continuous talking, and a screen recording that died
// silently. No real call audio is used; level streams are synthetic, shaped on
// the incident's measured RMS (both tracks -19 to -27 dBFS for 11.6 minutes).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { SpeechActivity } = require("../src/helpers/speechActivity");
const { MeetingStore } = require("../src/helpers/meetingStore");
const { MeetingRecorder } = require("../src/helpers/meetingRecorder");
const { parseAssertions, createMeetingActivity } = require("../src/helpers/meetingActivity");
const { RecordingAlerts, describe } = require("../src/helpers/recordingAlerts");
const { ScreenRecorder } = require("../src/helpers/screenRecorder");

// Deterministic pseudo-random sequence so the fixtures never change.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// A talk-heavy call: a gappy first couple of minutes (joining, small talk),
// then loudness wandering -19..-27 dBFS with only short breaths near the room
// floor, like the incident's recording. The old detector heard speech early,
// let its floor climb to about -26 dB, then stopped hearing anything: on these
// fixtures its last detection is at 384-462 s, so a 2-minute auto-stop fired
// mid-talk. (Checked by running the pre-fix speechActivity.js on them.)
function talkingLevels(seconds, { seed = 1, center = -23, spread = 4, intro = 120 } = {}) {
  const next = random(seed);
  const out = [];
  for (let t = 0.5; t <= seconds; t += 0.5) {
    const pause = t <= intro ? 0.55 : 0.06;
    out.push(next() < pause ? -50 + next() * 4 : center + (next() * 2 - 1) * spread);
  }
  return out;
}

function feed(child, source, levels, start = 0) {
  levels.forEach((db, index) =>
    child.stdout.write(
      JSON.stringify({ event: "level", source, t: start + (index + 1) * 0.5, db }) + "\n"
    )
  );
}

function callSetup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new MeetingStore(root);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => queueMicrotask(() => child.emit("close", null, "SIGKILL"));
  const alerts = [];
  let stopRequested = false;
  child.stdin.on("data", (data) => {
    if (!String(data).includes("stop")) return;
    stopRequested = true;
    child.stdout.write('{"event":"stopped","duration":1}\n');
    queueMicrotask(() => child.emit("close", 0));
  });
  const recorder = new MeetingRecorder(store, {
    binary: "/fake",
    spawn: () => child,
    onAlert: (alert) => alerts.push(alert),
    ...options,
  });
  return { store, child, recorder, alerts, stopRequested: () => stopRequested };
}

async function startCall(ctx, autoStopSeconds) {
  const item = ctx.store.create();
  const starting = ctx.recorder.start(item.id, { autoStopSeconds });
  ctx.child.stdout.write('{"event":"started"}\n');
  await starting;
  return item;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("the incident's talk-heavy audio no longer looks like silence", () => {
  // 11.6 minutes on each track, as measured on the failed call.
  for (const [source, seed] of [
    ["microphone", 7],
    ["system", 11],
  ]) {
    const activity = new SpeechActivity();
    let last = null;
    talkingLevels(698, { seed }).forEach((db, index) => {
      if (activity.push((index + 1) * 0.5, db)) last = (index + 1) * 0.5;
    });
    assert.ok(last >= 690, `${source} speech must be detected to the end (last ${last})`);
    assert.ok(activity.floor() <= -45, `${source} floor must not learn speech`);
  }
});

test("15+ minutes of continuous speech near -22 dBFS never auto-stops", async (t) => {
  const ctx = callSetup(t);
  await startCall(ctx, 120);
  feed(ctx.child, "microphone", talkingLevels(16 * 60, { seed: 3, center: -22, spread: 3 }));
  feed(ctx.child, "system", talkingLevels(16 * 60, { seed: 5, center: -22, spread: 3 }));
  await settle();
  assert.equal(ctx.stopRequested(), false);
  assert.equal(
    ctx.alerts.filter((a) => a.reason === "autoStopWarning").length,
    0,
    "no warning either"
  );
  ctx.recorder.stop(ctx.recorder.status().id, { requestedBy: "user" });
  await settle();
});

for (const [label, silenceDb] of [
  ["about -70 dBFS", -70],
  ["digital silence", -120],
]) {
  test(`real silence (${label}) after speech still auto-stops, with a warning first`, async (t) => {
    const ctx = callSetup(t);
    const item = await startCall(ctx, 120);
    feed(ctx.child, "microphone", talkingLevels(300, { seed: 9 }));
    const quiet = Array(260).fill(silenceDb); // 130 s
    feed(ctx.child, "microphone", quiet.slice(0, 190), 300); // 95 s quiet
    await settle();
    assert.equal(ctx.stopRequested(), false);
    const warning = ctx.alerts.find((a) => a.reason === "autoStopWarning");
    assert.ok(warning, "warned before stopping");
    assert.ok(warning.seconds <= 30 && warning.seconds > 20);
    assert.ok(ctx.recorder.status().autoStopWarning.secondsLeft <= 30);
    feed(ctx.child, "microphone", quiet.slice(190), 395);
    await settle();
    assert.equal(ctx.stopRequested(), true);
    assert.equal(ctx.store.get(item.id).autoStopped, true);
    assert.ok(ctx.alerts.some((a) => a.reason === "autoStopped" && a.seconds === 120));
  });
}

test('"Keep recording" during the warning prevents the stop', async (t) => {
  const ctx = callSetup(t);
  const item = await startCall(ctx, 120);
  feed(ctx.child, "microphone", talkingLevels(60, { seed: 4, intro: 0 }));
  feed(ctx.child, "microphone", Array(190).fill(-70), 60);
  await settle();
  assert.ok(ctx.recorder.status().autoStopWarning);
  ctx.recorder.keepRecording(item.id);
  assert.equal(ctx.recorder.status().autoStopWarning, null);
  // Another 60 s of quiet: past the original stop time, short of a fresh window.
  feed(ctx.child, "microphone", Array(120).fill(-70), 155);
  await settle();
  assert.equal(ctx.stopRequested(), false);
  ctx.recorder.stop(item.id, { requestedBy: "user" });
  await settle();
});

test("speech returning during the warning clears it", async (t) => {
  const ctx = callSetup(t);
  await startCall(ctx, 120);
  feed(ctx.child, "microphone", talkingLevels(60, { seed: 4, intro: 0 }));
  feed(ctx.child, "microphone", Array(190).fill(-70), 60);
  await settle();
  assert.ok(ctx.recorder.status().autoStopWarning);
  feed(ctx.child, "microphone", talkingLevels(10, { seed: 6, intro: 0 }), 155);
  await settle();
  assert.equal(ctx.recorder.status().autoStopWarning, null);
  assert.ok(ctx.alerts.some((a) => a.reason === "warningCleared"));
  ctx.recorder.stop(ctx.recorder.status().id, { requestedBy: "user" });
  await settle();
});

test("a meeting app holding a call open overrides silent audio", async (t) => {
  const ctx = callSetup(t, { meetingActive: async () => "Microsoft Teams" });
  await startCall(ctx, 60);
  feed(ctx.child, "microphone", talkingLevels(30, { seed: 2, intro: 0 }));
  feed(ctx.child, "microphone", Array(600).fill(-120), 30); // 5 minutes of nothing
  await settle();
  assert.equal(ctx.stopRequested(), false);
  assert.equal(ctx.recorder.status().heldBy, "Microsoft Teams");
  ctx.recorder.stop(ctx.recorder.status().id, { requestedBy: "user" });
  await settle();
});

test("power assertions identify live calls in Teams, Zoom, Webex and browsers", () => {
  const teams =
    '   pid 10069(MSTeams): [0x0000aa] 00:11:38 NoDisplaySleepAssertion named: "Microsoft Teams Call in progress"';
  assert.equal(parseAssertions(teams), "Microsoft Teams");
  assert.equal(
    parseAssertions('   pid 812(zoom.us): [0x01] 00:02:00 NoDisplaySleepAssertion named: "zoom"'),
    "Zoom"
  );
  assert.equal(
    parseAssertions('   pid 9(Webex): [0x01] 00:02:00 PreventUserIdleDisplaySleep named: "Webex"'),
    "Webex"
  );
  assert.match(
    parseAssertions(
      '   pid 77(Google Chrome): [0x01] 00:02:00 PreventUserIdleDisplaySleep named: "WebRTC has active PeerConnections"'
    ),
    /Google Chrome/
  );
  assert.equal(
    parseAssertions(
      '   pid 5(caffeinate): [0x01] 00:01:59 PreventUserIdleSystemSleep named: "caffeinate command-line tool"\n' +
        '   pid 52662(Claude): [0x01] 00:02:45 NoIdleSleepAssertion named: "Electron"'
    ),
    null
  );
});

test("the assertion check runs pmset at most once per cache window", async () => {
  let runs = 0;
  let clock = 0;
  const meetingActive = createMeetingActivity({
    now: () => clock,
    exec: (_bin, _args, _opts, done) => {
      runs++;
      done(null, '   pid 1(MSTeams): [0x1] 00:00:01 NoDisplaySleepAssertion named: "Call"');
    },
  });
  assert.equal(await meetingActive(), "Microsoft Teams");
  assert.equal(await meetingActive(), "Microsoft Teams");
  assert.equal(runs, 1);
  clock = 20000;
  await meetingActive();
  assert.equal(runs, 2);
});

test("call capture shows recording only after the files grow, and a stall alerts", async (t) => {
  let bytes = 0;
  const ctx = callSetup(t, { captureBytes: () => bytes, healthCheckMs: 5, stallMs: 40 });
  await startCall(ctx, 0);
  assert.equal(ctx.recorder.status().health, "verifying");
  bytes = 4096;
  await settle();
  assert.equal(ctx.recorder.status().health, "ok");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ctx.recorder.status().health, "stalled");
  assert.equal(ctx.alerts.filter((a) => a.reason === "stalled").length, 1);
  ctx.recorder.stop(ctx.recorder.status().id, { requestedBy: "user" });
  await settle();
});

test("a call recorder that dies mid-recording alerts at once", async (t) => {
  const ctx = callSetup(t);
  const item = await startCall(ctx, 0);
  ctx.child.emit("close", null, "SIGKILL");
  await settle();
  const alert = ctx.alerts.find((a) => a.reason === "failed");
  assert.ok(alert, "an unrequested exit is a failure");
  assert.equal(alert.id, item.id);
  assert.equal(ctx.store.get(item.id).status, "interrupted");
});

test("a stop the person asked for raises nothing", async (t) => {
  const ctx = callSetup(t);
  const item = await startCall(ctx, 0);
  await ctx.recorder.stop(item.id, { requestedBy: "user" });
  assert.deepEqual(ctx.alerts, []);
});

test("alerts put the tray in an error state until acknowledged", () => {
  const notified = [];
  const changes = [];
  const alerts = new RecordingAlerts({
    notify: (entry) => notified.push(entry),
    onChange: (state) => changes.push(state.hasError),
  });
  alerts.raise({ source: "call", reason: "autoStopWarning", seconds: 30 });
  assert.equal(alerts.state().hasError, false, "a warning is not an error");
  const stop = alerts.raise({ source: "call", reason: "autoStopped", seconds: 600 });
  assert.equal(alerts.state().alerts.length, 1, "the stop replaces its warning");
  assert.match(stop.body, /10 minutes/);
  alerts.raise({ source: "screen", reason: "failed", message: "Recorder exited" });
  assert.equal(alerts.state().hasError, true);
  assert.equal(notified.length, 3);
  alerts.acknowledge(stop.key);
  assert.equal(alerts.state().alerts.length, 1);
  alerts.acknowledge();
  assert.equal(alerts.state().hasError, false);
  assert.deepEqual(changes, [false, true, true, true, false]);
});

test("alert text never echoes audio and covers every reason", () => {
  for (const reason of [
    "autoStopWarning",
    "autoStopped",
    "stalled",
    "fellBack",
    "limit",
    "disk",
    "startFailed",
    "failed",
  ])
    for (const source of ["call", "screen"]) {
      const text = describe({ source, reason, seconds: 120 });
      assert.ok(text.title && text.body, `${source}/${reason}`);
      assert.doesNotMatch(text.body, /\{\{/);
    }
});

// Screen recorder

function screenSetup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ss-trust-screen-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spawned = [];
  const alerts = [];
  const recorder = new ScreenRecorder({
    directory,
    binary: "/fake",
    freeBytes: () => 50 * 1024 ** 3,
    spawn: (_binary, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.args = args;
      child.kill = () => queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      spawned.push(child);
      return child;
    },
    convert: async (args) => fs.writeFileSync(args[args.length - 1], "mp4"),
    onAlert: (alert) => alerts.push(alert),
    ...overrides,
  });
  return { directory, recorder, spawned, alerts };
}

for (const [label, displayID] of [
  ["minimized (still over a display)", 69733378],
  ["on another Space or closed (no display)", undefined],
]) {
  test(`window mode with an unavailable window (${label}) falls back to display capture`, async (t) => {
    const ctx = screenSetup(t);
    const starting = ctx.recorder.start({ source: { type: "window", id: 4242 } });
    const first = ctx.spawned[0];
    assert.deepEqual(first.args.slice(1, 3), ["--window", "4242"]);
    first.stdout.write(
      JSON.stringify({
        event: "error",
        code: "window-unavailable",
        message: "That window isn't on screen",
        ...(displayID ? { displayID } : {}),
      }) + "\n"
    );
    first.emit("close", 3);
    await new Promise(setImmediate);
    const second = ctx.spawned[1];
    assert.ok(second, "retried with a display");
    assert.equal(second.args.includes("--window"), false);
    if (displayID) assert.deepEqual(second.args.slice(1, 3), ["--display", String(displayID)]);
    else assert.equal(second.args.includes("--display"), false, "main display");
    fs.writeFileSync(second.args[0], "mov");
    second.stdout.write('{"event":"started"}\n');
    const status = await starting;
    assert.equal(status.recording, true);
    assert.equal(status.fellBack, true);
    assert.ok(ctx.alerts.some((a) => a.reason === "fellBack"));
    const stopping = ctx.recorder.stop();
    second.stdout.write('{"event":"stopped","duration":3,"hasVideo":true}\n');
    second.emit("close", 0);
    await stopping;
  });
}

test("a screen recorder killed mid-recording alerts and keeps what was captured", async (t) => {
  const ctx = screenSetup(t);
  const starting = ctx.recorder.start({ systemAudio: true, microphone: true });
  const child = ctx.spawned[0];
  fs.writeFileSync(child.args[0], "mov");
  child.stdout.write('{"event":"started"}\n');
  await starting;
  child.emit("close", null, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ctx.alerts.some((a) => a.source === "screen" && a.reason === "failed"));
  assert.ok(ctx.recorder.lastResult.file, "the partial recording is kept");
});

test("a screen start failure alerts (except for permission, which has its own guidance)", async (t) => {
  const ctx = screenSetup(t);
  const starting = ctx.recorder.start();
  ctx.spawned[0].stdout.write('{"event":"error","code":"capture","message":"boom"}\n');
  ctx.spawned[0].emit("close", 1);
  await assert.rejects(starting, /boom/);
  assert.ok(ctx.alerts.some((a) => a.reason === "startFailed"));
  const again = ctx.recorder.start();
  ctx.spawned[1].stdout.write('{"event":"error","code":"permission","message":"declined"}\n');
  ctx.spawned[1].emit("close", 1);
  await assert.rejects(again, /declined/);
  assert.equal(ctx.alerts.filter((a) => a.reason === "startFailed").length, 1);
});

test("screen recording verifies growth before it counts as recording, then flags a stall", async (t) => {
  const ctx = screenSetup(t, { healthCheckMs: 5, stallMs: 40 });
  const starting = ctx.recorder.start({ systemAudio: true });
  const child = ctx.spawned[0];
  fs.writeFileSync(child.args[0], "");
  child.stdout.write('{"event":"started"}\n');
  await starting;
  assert.equal(ctx.recorder.status().health, "verifying");
  fs.writeFileSync(child.args[0], "fragment-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.recorder.status().health, "ok");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ctx.recorder.status().health, "stalled");
  assert.ok(ctx.alerts.some((a) => a.reason === "stalled"));
  const stopping = ctx.recorder.stop();
  child.stdout.write('{"event":"stopped","duration":3,"hasVideo":true}\n');
  child.emit("close", 0);
  await stopping;
  assert.equal(ctx.alerts.filter((a) => a.reason === "failed").length, 0);
});

test("the disk guard stop is reported", async (t) => {
  let free = 50 * 1024 ** 3;
  const ctx = screenSetup(t, { freeBytes: () => free });
  const starting = ctx.recorder.start();
  const child = ctx.spawned[0];
  fs.writeFileSync(child.args[0], "mov");
  child.stdout.write('{"event":"started"}\n');
  await starting;
  free = 0;
  // Trigger the guard directly rather than waiting 30 s.
  ctx.recorder.active.reason = "disk";
  const stopping = ctx.recorder.stop({ requestedBy: "disk" });
  child.stdout.write('{"event":"stopped","duration":3,"hasVideo":true}\n');
  child.emit("close", 0);
  await stopping;
  assert.ok(ctx.alerts.some((a) => a.reason === "disk"));
});
