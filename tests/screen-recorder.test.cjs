const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { ScreenRecorder, finalizeArgs, timestampName } = require("../src/helpers/screenRecorder");

function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ss-screen-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spawned = [];
  const conversions = [];
  let awake = 0;
  const recorder = new ScreenRecorder({
    directory,
    binary: "/fake",
    freeBytes: () => 50 * 1024 ** 3,
    spawn: (binary, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.args = args;
      child.kill = () => queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      spawned.push(child);
      return child;
    },
    convert: async (args) => {
      conversions.push(args);
      fs.writeFileSync(args[args.length - 1], "mp4");
    },
    keepAwake: () => {
      awake++;
      return () => awake--;
    },
    ...overrides,
  });
  return { directory, recorder, spawned, conversions, awake: () => awake };
}

async function record(ctx, options) {
  const starting = ctx.recorder.start(options);
  const child = ctx.spawned.at(-1);
  fs.writeFileSync(child.args[0], "mov");
  child.stdout.write('{"event":"started"}\n');
  await starting;
  return child;
}

async function finish(ctx, child, stopped = '{"event":"stopped","duration":12,"hasVideo":true}') {
  const stopping = ctx.recorder.stop();
  child.stdout.write(stopped + "\n");
  child.emit("close", 0);
  return stopping;
}

test("records, mixes both audio tracks into an mp4 and lists it", async (t) => {
  const ctx = setup(t);
  const child = await record(ctx, { source: { type: "window", id: 42 }, systemAudio: true, microphone: true });
  assert.deepEqual(child.args.slice(1), ["--window", "42", "--system-audio", "--microphone"]);
  assert.equal(ctx.recorder.status().recording, true);
  assert.equal(ctx.awake(), 1);
  await assert.rejects(ctx.recorder.start(), /already/);
  assert.deepEqual(ctx.recorder.list(), [], "the in-progress file is hidden");
  const result = await finish(ctx, child);
  assert.equal(result.duration, 12);
  assert.match(result.file, /\.mp4$/);
  assert.ok(ctx.conversions[0].join(" ").includes("amix=inputs=2"));
  assert.equal(fs.existsSync(child.args[0]), false, "the .mov is replaced by the .mp4");
  assert.equal(ctx.awake(), 0);
  assert.equal(ctx.recorder.status().recording, false);
  assert.deepEqual(
    ctx.recorder.list().map((file) => path.extname(file.name)),
    [".mp4"]
  );
});

test("a failed conversion keeps the playable .mov", async (t) => {
  const ctx = setup(t, {
    convert: async () => {
      throw new Error("ffmpeg crashed");
    },
  });
  const child = await record(ctx, { systemAudio: true, microphone: false });
  const result = await finish(ctx, child);
  assert.equal(result.file, child.args[0]);
  assert.equal(result.convertError, "ffmpeg crashed");
  assert.equal(ctx.recorder.list()[0].name.endsWith(".mov"), true);
});

test("permission refusal rejects start with a permission code and leaves no file", async (t) => {
  const ctx = setup(t);
  const starting = ctx.recorder.start();
  const child = ctx.spawned.at(-1);
  child.stdout.write('{"event":"error","code":"permission","message":"declined"}\n');
  child.emit("close", 1);
  await assert.rejects(starting, (error) => error.code === "permission");
  assert.equal(ctx.recorder.status().recording, false);
  assert.equal(ctx.awake(), 0);
  assert.deepEqual(fs.readdirSync(ctx.directory), []);
});

test("refuses to start with too little disk and stops itself when space runs out", async (t) => {
  const low = setup(t, { freeBytes: () => 1024 ** 3 });
  await assert.rejects(low.recorder.start(), (error) => error.code === "disk");
  assert.equal(low.spawned.length, 0);

  let free = 50 * 1024 ** 3;
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const ctx = setup(t, { freeBytes: () => free });
  const child = await record(ctx, {});
  let wrote = "";
  child.stdin.on("data", (chunk) => (wrote += chunk));
  free = 500 * 1024 ** 2;
  t.mock.timers.tick(30000);
  await new Promise(setImmediate);
  assert.equal(wrote, "stop\n");
  child.stdout.write('{"event":"stopped","duration":5,"hasVideo":true}\n');
  child.emit("close", 0);
  const result = await ctx.recorder.stop().catch(() => null);
  assert.equal(result, null, "already finished");
  assert.equal(ctx.recorder.status().last.reason, "disk");
});

test("a recording that captured no frames is discarded", async (t) => {
  const ctx = setup(t);
  const child = await record(ctx, {});
  const result = await finish(ctx, child, '{"event":"stopped","duration":0,"hasVideo":false}');
  assert.equal(result.file, null);
  assert.deepEqual(ctx.recorder.list(), []);
});

test("resolve only accepts listed recordings inside the folder", (t) => {
  const ctx = setup(t);
  fs.writeFileSync(path.join(ctx.directory, "a.mp4"), "x");
  assert.equal(ctx.recorder.resolve("a.mp4"), path.join(ctx.directory, "a.mp4"));
  for (const bad of ["../a.mp4", "/etc/passwd", "a.txt", ".hidden.mp4", "missing.mp4", 7])
    assert.throws(() => ctx.recorder.resolve(bad));
});

test("finalize copies video and only mixes when there are two audio tracks", () => {
  const none = finalizeArgs("in.mov", "out.mp4", 0).join(" ");
  assert.match(none, /-c:v copy/);
  assert.doesNotMatch(none, /0:a/);
  assert.match(finalizeArgs("in.mov", "out.mp4", 1).join(" "), /-map 0:a:0 -c:a copy/);
  assert.match(finalizeArgs("in.mov", "out.mp4", 2).join(" "), /amix=inputs=2/);
  assert.equal(timestampName(new Date(2026, 9, 21, 9, 5, 3)), "Screen Recording 2026-10-21 at 09.05.03");
});
