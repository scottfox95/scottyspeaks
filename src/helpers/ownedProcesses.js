const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Long-lived inference servers (llama-server, whisper-server, sherpa-onnx,
// parakeet-coreml) are separate processes. If SS2 crashes they keep running
// with their model in RAM, and the next launch starts a second copy on the
// next port. Every server we spawn is recorded here (pid + binary path) so the
// next launch can find and stop the ones a crashed run left behind, and so a
// normal exit can take them down even when a stop() never ran.

const FILE_NAME = "owned-processes.json";
const KILL_GRACE_MS = 2000;

let registryPath = null;
const live = new Map(); // pid -> { pid, name, binary, startedAt }
let exitHookInstalled = false;

function resolveRegistryPath() {
  if (registryPath) return registryPath;
  try {
    const { app } = require("electron");
    if (app?.getPath) registryPath = path.join(app.getPath("userData"), FILE_NAME);
  } catch {
    // Not running inside Electron (tests): stay in-memory until configured.
  }
  return registryPath;
}

function setRegistryPath(filePath) {
  registryPath = filePath;
}

function readEntries(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((e) => Number.isInteger(e?.pid) && e.binary) : [];
  } catch {
    return [];
  }
}

function persist() {
  const filePath = resolveRegistryPath();
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([...live.values()]));
  } catch {
    // Best effort: losing the record only means a crash could orphan a server.
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/// The command line a pid is running, or null. Used so a recycled pid that now
/// belongs to some unrelated program is never signalled.
function commandLineOf(pid) {
  if (process.platform === "win32") return null;
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function belongsToUs(entry, getCommandLine = commandLineOf) {
  const command = getCommandLine(entry.pid);
  return typeof command === "string" && command.startsWith(entry.binary);
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 'exit' handlers must be synchronous; a SIGTERM is enough for these servers.
  process.on("exit", () => {
    for (const { pid } of live.values()) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  });
}

/// Records a spawned server until it exits.
function track(child, { name, binary }) {
  if (!child?.pid || !binary) return;
  const pid = child.pid;
  live.set(pid, { pid, name: name || path.basename(binary), binary, startedAt: Date.now() });
  persist();
  installExitHook();
  child.once("exit", () => {
    if (live.delete(pid)) persist();
  });
}

/// Stops servers recorded by a previous run that are still alive and still
/// running the recorded binary. Returns the entries it signalled.
function reapStale({
  filePath = resolveRegistryPath(),
  getCommandLine = commandLineOf,
  kill = (pid, signal) => process.kill(pid, signal),
  graceMs = KILL_GRACE_MS,
} = {}) {
  if (!filePath || process.platform === "win32") return [];
  const entries = readEntries(filePath).filter((entry) => entry.pid !== process.pid && !live.has(entry.pid));
  const reaped = [];

  for (const entry of entries) {
    if (!isAlive(entry.pid) || !belongsToUs(entry, getCommandLine)) continue;
    try {
      kill(entry.pid, "SIGTERM");
      reaped.push(entry);
    } catch {
      continue;
    }
    if (graceMs > 0) {
      const timer = setTimeout(() => {
        if (isAlive(entry.pid) && belongsToUs(entry, getCommandLine)) {
          try {
            kill(entry.pid, "SIGKILL");
          } catch {
            // exited meanwhile
          }
        }
      }, graceMs);
      timer.unref?.();
    }
  }

  // Whatever was in the file belonged to a dead run; start fresh with ours.
  try {
    fs.writeFileSync(filePath, JSON.stringify([...live.values()]));
  } catch {
    // ignore
  }
  return reaped;
}

function _resetForTests() {
  live.clear();
  registryPath = null;
}

module.exports = {
  track,
  reapStale,
  setRegistryPath,
  belongsToUs,
  _resetForTests,
  _live: live,
};
