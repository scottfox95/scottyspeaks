const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { CallAgentStore } = require("../src/helpers/callAgentStore");
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ss2-agent-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const call = {
    id: crypto.randomUUID(),
    revision: 1,
    title: "Synthetic client call",
    createdAt: new Date().toISOString(),
    notes: "Review the requirement.",
    transcript: "We should test by Friday.",
    transcriptEdited: false,
    segments: [{ start: 2, end: 4, text: "We should test by Friday.", speaker: "speaker1" }],
    speakers: { speaker1: "Morgan" },
  };
  const store = new CallAgentStore(root, {
    readCall: (id) => {
      assert.equal(id, call.id);
      return call;
    },
  });
  return { root, call, store };
}
test("only explicitly shared calls are readable and revocation invalidates access", (t) => {
  const { call, store } = setup(t);
  assert.throws(() => store.read(call.id), /not shared/);
  assert.deepEqual(store.list(), []);
  store.grant(call.id);
  const shared = store.read(call.id);
  assert.equal(shared.title, call.title);
  assert.equal(shared.evidence[0].speaker, "Morgan");
  assert.equal(shared.evidence[0].start, 2);
  assert.equal(store.list().length, 1);
  store.revoke(call.id);
  assert.throws(() => store.read(call.id), /not shared/);
  assert.throws(() => store.read("../openrouter-key.enc"), /Invalid/);
});
test("agent draft citations bind to current permission and source version without mutating call", (t) => {
  const { call, store } = setup(t);
  store.grant(call.id);
  const view = store.read(call.id),
    original = JSON.stringify(call);
  const args = {
    callId: call.id,
    grantId: view.grantId,
    sourceVersion: view.sourceVersion,
    title: "Follow-up",
    body: "Prepare tests by Friday.",
    citations: [view.evidence[0].id],
  };
  const draft = store.submitDraft(args);
  assert.equal(draft.citations[0].quote, call.segments[0].text);
  assert.equal(JSON.stringify(call), original);
  assert.equal(store.listDrafts(call.id).length, 1);
  assert.throws(() => store.submitDraft({ ...args, citations: ["invented"] }), /evidence/);
  call.notes = "Changed notes";
  call.revision++;
  assert.throws(() => store.submitDraft(args), /changed/);
  store.revoke(call.id);
  store.grant(call.id);
  assert.throws(
    () => store.submitDraft({ ...args, sourceVersion: store.read(call.id).sourceVersion }),
    /permission/
  );
});
test("edited and text-only transcripts retain honest untimed evidence", (t) => {
  const { call, store } = setup(t);
  call.segments = [];
  call.transcriptEdited = true;
  store.grant(call.id);
  const shared = store.read(call.id);
  assert.equal(shared.transcriptEdited, true);
  assert.equal(shared.evidence[0].start, null);
  assert.equal(shared.evidence[0].kind, "transcript");
  assert.ok(shared.evidence.some((item) => item.kind === "notes"));
});
test("rejects path/symlink and oversized draft payloads; user can remove separate drafts", (t) => {
  const { call, store, root } = setup(t);
  store.grant(call.id);
  const shared = store.read(call.id);
  const args = {
    callId: call.id,
    grantId: shared.grantId,
    sourceVersion: shared.sourceVersion,
    title: "Draft",
    body: "text",
    citations: [shared.evidence[0].id],
  };
  assert.throws(() => store.submitDraft({ ...args, body: "x".repeat(200001) }), /Invalid/);
  const draft = store.submitDraft(args);
  const file = path.join(root, "drafts", draft.id + ".json");
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(root, "grants", call.id + ".json"), file);
  assert.throws(() => store.getDraft(draft.id), /regular/);
  fs.unlinkSync(file);
  store.submitDraft(args);
  const id = store.listDrafts(call.id)[0].id;
  store.deleteDraft(id);
  assert.equal(store.listDrafts(call.id).length, 0);
});
test("bounds serialized draft evidence before storing citations", (t) => {
  const { call, store } = setup(t);
  call.notes = "x".repeat(900000);
  store.grant(call.id);
  const view = store.read(call.id);
  assert.throws(
    () =>
      store.submitDraft({
        callId: call.id,
        grantId: view.grantId,
        sourceVersion: view.sourceVersion,
        title: "Bounded",
        body: "body",
        citations: view.evidence.map((x) => x.id),
      }),
    /too large/
  );
  assert.equal(store.listDrafts(call.id).length, 0);
});
