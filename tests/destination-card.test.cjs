// Overlay v2, Direction B: the destination card renders every state from the
// mockup with the right words and actions.
const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const root = path.join(__dirname, "..");
const en = JSON.parse(fs.readFileSync(path.join(root, "src/locales/en/translation.json"), "utf8"));

// Minimal i18next-style t(): nested keys, {{vars}}, _one/_other plurals.
function t(key, vars = {}) {
  const lookup = (k) => k.split(".").reduce((node, part) => (node == null ? node : node[part]), en);
  let value = lookup(key);
  if (value === undefined && vars.count !== undefined)
    value = lookup(`${key}_${vars.count === 1 ? "one" : "other"}`);
  if (typeof value !== "string") return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
}

const stub = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ss2-card-")), "i18n.js");
fs.writeFileSync(stub, "module.exports = { useTranslation: () => ({ t: globalThis.__t }) };");
const out = esbuild.buildSync({
  entryPoints: [path.join(root, "src/components/overlay/DestinationCard.jsx")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react-dom"],
  loader: { ".css": "empty" },
  alias: { "react-i18next": stub },
});
globalThis.__t = t;
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
const { default: DestinationCard } = mod.exports;
const stateMod = { exports: {} };
new Function(
  "module",
  "exports",
  "require",
  esbuild.buildSync({
    entryPoints: [path.join(root, "src/components/overlay/overlayState.js")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
  }).outputFiles[0].text
)(stateMod, stateMod.exports, require);
const { overlayStateFor, formatElapsed } = stateMod.exports;
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const levels = new Array(28).fill(0).map((_, i) => (i % 5) / 4);
const render = (props) =>
  renderToStaticMarkup(
    React.createElement(DestinationCard, {
      targetApp: "Slack",
      levels,
      startedAt: Date.now() - 7_200,
      pasteAgainLabel: "⌃⌥V",
      ...props,
    })
  ).replace(/<!-- -->/g, "");
const text = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

test("overlay state follows recording, processing stage and outcome", () => {
  assert.equal(overlayStateFor({ isRecording: true }), "listening");
  assert.equal(overlayStateFor({ isProcessing: true, pipelineStage: "transcribing" }), "transcribing");
  assert.equal(overlayStateFor({ isProcessing: true, pipelineStage: "refining" }), "polishing");
  assert.equal(overlayStateFor({ outcome: { kind: "pasted" } }), "pasted");
  assert.equal(overlayStateFor({ outcome: null }), null);
  assert.equal(formatElapsed(7_200), "0:07");
  assert.equal(formatElapsed(75_000), "1:15");
});

test("listening: destination, live level meter, timer and Cancel (Esc)", () => {
  const html = render({ state: "listening" });
  assert.match(text(html), /Into Slack/);
  assert.match(html, /ss2-card__wave is-live/);
  assert.equal((html.match(/<i style="height:/g) || []).length, 28);
  assert.match(html, /height:31px/, "a full-scale level reaches the top of the meter");
  assert.match(text(html), /0:07/);
  assert.match(text(html), /Listening/);
  assert.match(text(html), /Cancel Esc/);
  assert.doesNotMatch(text(html), /Paste raw now/);
});

test("transcribing: meter at rest, Cancel still offered", () => {
  const html = render({ state: "transcribing" });
  assert.doesNotMatch(html, /is-live/);
  assert.match(text(html), /Transcribing/);
  assert.match(text(html), /Cancel Esc/);
});

test("polishing offers Paste raw now (Esc) as the primary action", () => {
  const html = render({ state: "polishing" });
  assert.match(text(html), /Polishing/);
  assert.match(html, /is-primary[^>]*>Paste raw now <kbd>Esc<\/kbd>/);
  assert.doesNotMatch(text(html), /Cancel/);
});

test("pasted names the app, the word count and the paste-again shortcut", () => {
  const html = render({ state: "pasted", outcome: { kind: "pasted", app: "Slack", words: 9 } });
  assert.match(text(html), /Pasted into Slack ✓ · 9 words\. ⌃⌥V pastes it again\./);
  assert.match(html, /is-ok/);
  const one = render({ state: "pasted", outcome: { kind: "pasted", app: "Slack", words: 1 }, pasteAgainLabel: "" });
  assert.match(text(one), /1 word\.$/);
});

test("on clipboard explains the reason and waits for Got it", () => {
  const html = render({
    state: "clipboard",
    outcome: { kind: "clipboard", app: "Slack", reason: "a password field is active" },
  });
  assert.match(text(html), /It's on your clipboard\. SS2 couldn't paste into Slack \(a password field is active\)\. Press ⌘V/);
  assert.match(text(html), /Got it/);
  assert.match(html, /is-amber/);
});

test("failure shows the reason in an error note", () => {
  const html = render({
    state: "failed",
    targetApp: "",
    outcome: { kind: "failed", title: "Microphone Access Denied", description: "Grant access in System Settings." },
  });
  assert.match(text(html), /Microphone Access Denied Grant access in System Settings\./);
  assert.match(html, /is-error/);
  assert.match(text(html), /Dictating/, "no app captured yet");
});

test("cancelled says nothing was pasted", () => {
  const html = render({ state: "cancelled", outcome: { kind: "cancelled" } });
  assert.match(text(html), /Cancelled\. Nothing was pasted\./);
});

test("every overlay string exists in all 10 locales", () => {
  const keys = (node, prefix = "") =>
    Object.entries(node).flatMap(([k, v]) => (typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const required = keys(en.overlay).filter((k) => !/_(one|few|many)$/.test(k));
  for (const lang of fs.readdirSync(path.join(root, "src/locales"))) {
    const file = path.join(root, "src/locales", lang, "translation.json");
    if (!fs.existsSync(file)) continue;
    const overlay = JSON.parse(fs.readFileSync(file, "utf8")).overlay;
    for (const key of required) {
      const value = key.split(".").reduce((node, part) => node?.[part], overlay);
      assert.equal(typeof value, "string", `${lang}: overlay.${key}`);
    }
  }
});

test("reduced motion keeps fades and drops movement, scale and blur", () => {
  const css = fs.readFileSync(path.join(root, "src/components/overlay/destinationCard.css"), "utf8");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /animation: ss2-card-fade/);
  assert.match(reduced, /transform: none/);
  assert.match(reduced, /filter: none/);
  assert.doesNotMatch(css, /transition:\s*all/);
  assert.doesNotMatch(css, /ease-in[^-]/);
});
