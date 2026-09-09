#!/usr/bin/env node
/**
 * Prints why SS2 is fast or slow on this Mac: power mode, which models are
 * actually downloaded, which one is selected, whether the AI server is warm,
 * and a real timed inference.
 *
 * Standalone — no repo dependencies. Copy this single file anywhere and run
 * `node diagnose.js` (or `npm run diagnose` inside the repo).
 */
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const MODELS_DIR = path.join(os.homedir(), ".cache", "scottyspeaks");
const USER_DATA = path.join(os.homedir(), "Library", "Application Support", "scotty-speaks");

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const gb = (bytes) => (bytes / 1073741824).toFixed(2) + " GB";

function section(title) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 46 - title.length))}`);
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

function httpJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function postJson(url, body, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: timeoutMs },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log("SS2 diagnostics");
  console.log("=".repeat(50));

  section("Machine");
  console.log("Chip     :", sh("sysctl", ["-n", "machdep.cpu.brand_string"]) || "unknown");
  const memBytes = Number(sh("sysctl", ["-n", "hw.memsize"]) || 0);
  console.log("Memory   :", memBytes ? gb(memBytes) : "unknown");
  console.log("macOS    :", sh("sw_vers", ["-productVersion"]));

  section("Power / thermal  (the usual cause of 'slower on a better Mac')");
  const pm = sh("pmset", ["-g"]);
  const lowPower = /lowpowermode\s+1/i.test(pm);
  console.log("Low Power Mode :", lowPower ? "ON  ← throttles CPU/GPU, turn this OFF" : "off");
  const power = sh("pmset", ["-g", "ps"]);
  console.log("Power source   :", /AC Power/.test(power) ? "AC (plugged in)" : "Battery  ← plug in for full speed");
  const thermal = sh("pmset", ["-g", "therm"]);
  const cpuLimit = (thermal.match(/CPU_Speed_Limit\s+=\s+(\d+)/) || [])[1];
  if (cpuLimit && cpuLimit !== "100") console.log(`Thermal limit  : CPU at ${cpuLimit}%  ← throttling`);
  else console.log("Thermal limit  : none");

  section("Models on disk");
  if (!fs.existsSync(MODELS_DIR)) {
    console.log("No model cache — nothing downloaded yet at", MODELS_DIR);
  } else {
    for (const sub of ["models", "parakeet-models", "whisper-models"]) {
      const p = path.join(MODELS_DIR, sub);
      if (!fs.existsSync(p)) { console.log(`${sub.padEnd(17)}: (none)`); continue; }
      const files = fs.readdirSync(p);
      console.log(`${sub.padEnd(17)}: ${gb(dirSize(p))}  [${files.join(", ") || "empty"}]`);
    }
  }

  section("Selected engines (from your settings)");
  const lsLog = path.join(USER_DATA, "Local Storage", "leveldb");
  let settingsBlob = "";
  try {
    for (const f of fs.readdirSync(lsLog)) {
      if (f.endsWith(".log") || f.endsWith(".ldb")) {
        settingsBlob += fs.readFileSync(path.join(lsLog, f), "latin1");
      }
    }
  } catch {}
  // The settings store is a leveldb; rather than parse it, look for which
  // known identifiers appear — enough to compare two machines.
  const KNOWN = [
    ["qwen3-4b-instruct-2507-q4_k_m", "AI polish: Qwen3 4B Instruct (fast — expected)"],
    ["qwen3-8b-q4_k_m", "AI polish: Qwen3 8B (SLOW — thinking model, ~20s)"],
    ["qwen3-32b", "AI polish: Qwen3 32B (very slow on 16GB)"],
    ["gpt-oss-20b", "AI polish: GPT-OSS 20B (slow)"],
    ["parakeet-tdt-0.6b-v3", "Transcription: Parakeet (fast — expected)"],
    ["large-v3-turbo", "Transcription: Whisper large-v3-turbo (slower than Parakeet)"],
  ];
  const found = KNOWN.filter(([id]) => settingsBlob.includes(id));
  if (found.length) found.forEach(([, label]) => console.log(" •", label));
  else console.log(" (could not read settings — compare Settings > AI on both Macs)");
  console.log("Note: a name appearing here means it was selected at some point;");
  console.log("check Settings > Transcription / AI in the app for what's active now.");

  section("Running processes");
  const ps = sh("ps", ["ax", "-o", "command"]);
  const running = (needle) => ps.split("\n").some((l) => l.includes(needle));
  console.log("SS2 app       :", running("SS2.app/Contents/MacOS") ? "running" : "NOT running");
  console.log("AI polish     :", running("llama-server") ? "running (warm)" : "NOT running ← first dictation pays model load");
  console.log("Transcription :", running("sherpa-onnx") ? "running (Parakeet, warm)" : "not running");

  section("Live AI speed test");
  let health = null, port = null;
  for (let p = 8200; p <= 8220; p++) {
    health = await httpJson(`http://127.0.0.1:${p}/health`);
    if (health) { port = p; break; }
  }
  if (!health) {
    console.log("AI server not reachable — open SS2 and wait ~15s, then re-run.");
  } else {
    console.log(`Server on port ${port}: ${health.status}`);
    const t0 = Date.now();
    const res = await postJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
      messages: [
        { role: "system", content: "Rewrite the user's dictation as clean written text. Output only the text." },
        { role: "user", content: "so um i think we should probably go ahead and ship it today and then follow up tomorrow" },
      ],
      temperature: 0.2, max_tokens: 256, stream: false,
    });
    const ms = Date.now() - t0;
    const txt = res?.choices?.[0]?.message?.content?.trim();
    console.log(`Polish round-trip: ${ms} ms`);
    if (txt) console.log(`Output: ${txt}`);
    console.log(ms < 3500 ? "→ Healthy (this Mac does ~0.4-3s)" : "→ SLOW: see notes below");
  }

  section("What to check if it's slow");
  console.log("1. Low Power Mode ON or on battery → biggest and most common cause.");
  console.log("2. AI polish 'NOT running' above → the model reloads per dictation.");
  console.log("3. Corporate security software (MDM/EDR) scanning each spawned");
  console.log("   process adds latency SS2 cannot avoid — check with IT.");
  console.log("4. A larger model selected than on the other Mac (compare the");
  console.log("   'Selected engines' section between machines).");
  console.log("5. Models still downloading in the background after setup.");
  console.log("");
})();
