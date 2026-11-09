const { execFile } = require("child_process");

// Meeting apps hold a macOS power assertion for as long as a call is live, e.g.
//   pid 10069(MSTeams): [0x…] 00:11:38 NoDisplaySleepAssertion named: "Microsoft Teams Call in progress"
// A call recording must never auto-stop while one of these is held, however
// quiet the audio looks. Browsers (Meet, Teams web) hold a WebRTC assertion.
const MEETING_PROCESSES = [
  { app: "Microsoft Teams", process: /^(MSTeams|Microsoft Teams)/i },
  { app: "Zoom", process: /^(zoom\.us|CptHost)/i },
  { app: "Webex", process: /^(Webex|Cisco Webex)/i },
  { app: "FaceTime", process: /^FaceTime/i },
  { app: "Slack", process: /^Slack/i, name: /huddle|call/i },
];
const BROWSER_CALL = /WebRTC/i;
const CACHE_MS = 10000;

// Returns the name of the meeting app holding a call open, or null.
function parseAssertions(text) {
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/pid\s+\d+\(([^)]+)\):.*?named:\s*"([^"]*)"/);
    if (!match) continue;
    const [, processName, name] = match;
    for (const entry of MEETING_PROCESSES)
      if (entry.process.test(processName) && (!entry.name || entry.name.test(name)))
        return entry.app;
    if (BROWSER_CALL.test(name)) return `${processName} (browser call)`;
  }
  return null;
}

function createMeetingActivity({ exec = execFile, now = Date.now } = {}) {
  let cached = null;
  return function meetingActive() {
    if (process.platform !== "darwin" && exec === execFile) return Promise.resolve(null);
    if (cached && now() - cached.at < CACHE_MS) return cached.promise;
    const promise = new Promise((resolve) => {
      exec("/usr/bin/pmset", ["-g", "assertions"], { timeout: 5000 }, (error, stdout) =>
        resolve(error ? null : parseAssertions(stdout))
      );
    });
    cached = { at: now(), promise };
    return promise;
  };
}

module.exports = { parseAssertions, createMeetingActivity };
