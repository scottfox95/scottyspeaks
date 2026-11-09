/**
 * In-app updater for SS2.
 *
 * `npm run publish` ships each build as a GitHub Release holding a single
 * `SS2-<version>.zip` (SS2.app inside). This updater mirrors what
 * SS2-Update.command does: read the latest release from the GitHub API,
 * compare versions, download the zip, unpack it with ditto, verify the
 * signature, and swap the running app bundle in place after quitting.
 *
 * electron-updater/Squirrel.Mac is deliberately not used: it needs a
 * latest-*-mac.yml manifest the publish script doesn't produce, and it
 * validates update signatures in a way that's unproven with the local
 * self-signed identity.
 *
 * Automatic: checks shortly after launch and every few hours, downloads a
 * newer release in the background, and installs it when SS2 next quits
 * (or right away from Settings). The first launch of a new version shows
 * "Updated to x.y.z". The download must be signed by the same identity as
 * the running app (its designated requirement pins the certificate), so a
 * zip signed by anyone else is rejected. Set SS2_AUTO_UPDATE=0 to turn the
 * automatic part off; manual checks keep working.
 *
 * The public method names and renderer events (update-available,
 * update-download-progress, update-downloaded, update-error, …) are kept
 * so useUpdater.ts and the Settings UI work unchanged.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const REPO = "scottfox95/scottyspeaks";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const ZIP_ASSET_PATTERN = /^SS2-.*\.zip$/i;
const STARTUP_CHECK_DELAY_MS = 15000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// `codesign -d -r-` prints "designated => <requirement>" (on stdout or stderr
// depending on the macOS version).
function parseDesignatedRequirement(output) {
  const match = String(output || "").match(/designated => (.+)/);
  return match ? match[1].trim() : null;
}

function parseVersion(v) {
  return String(v || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class UpdateManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.lastUpdateInfo = null;
    this.isInstalling = false;
    this.isDownloading = false;
    this.isStartupCheck = false;

    this.release = null; // { version, asset: { name, url, size } }
    this.stagedAppPath = null; // unpacked, verified SS2.app ready to swap in
    this.stagingDir = null;
    this.quitHookInstalled = false;
  }

  get isDev() {
    return process.env.NODE_ENV === "development";
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;
  }

  notifyRenderers(channel, data) {
    for (const win of [this.mainWindow, this.controlPanelWindow]) {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, data);
      }
    }
  }

  reportError(err) {
    console.error("❌ Updater error:", err);
    // Errors don't survive structured clone well; send the message.
    const message = err?.message || String(err);
    if (!this.isStartupCheck) {
      this.notifyRenderers("update-error", message);
    }
  }

  /** Path of the running .app bundle, or null when not running from one. */
  getRunningBundlePath() {
    const bundle = path.resolve(process.execPath, "..", "..", "..");
    return bundle.endsWith(".app") ? bundle : null;
  }

  async fetchLatestRelease() {
    const res = await fetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "SS2-Updater",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub releases request failed (HTTP ${res.status})`);
    }
    const data = await res.json();
    const version = String(data.tag_name || "").replace(/^v/i, "");
    const asset = (data.assets || []).find((a) => ZIP_ASSET_PATTERN.test(a.name));
    if (!version) throw new Error("Latest release has no version tag");
    if (!asset) throw new Error(`Release ${data.tag_name} has no SS2 zip attached`);
    return {
      version,
      releaseDate: data.published_at,
      releaseNotes: data.body || null,
      asset: { name: asset.name, url: asset.browser_download_url, size: asset.size },
    };
  }

  async checkForUpdates() {
    if (this.isDev) {
      return { updateAvailable: false, message: "Update checks are disabled in development mode" };
    }
    if (process.platform !== "darwin") {
      return { updateAvailable: false, message: "Updates are only published for macOS" };
    }

    const { app } = require("electron");
    this.notifyRenderers("checking-for-update");
    console.log("🔍 Checking for updates...");

    try {
      const release = await this.fetchLatestRelease();
      const current = app.getVersion();

      if (!isNewer(release.version, current)) {
        console.log(`✅ Already on latest version (${current}; latest ${release.version})`);
        this.updateAvailable = false;
        this.lastUpdateInfo = null;
        this.notifyRenderers("update-not-available", { version: release.version });
        return { updateAvailable: false, message: "You are running the latest version" };
      }

      // A newer release than the one already staged invalidates the staged copy.
      if (this.release && this.release.version !== release.version) {
        this.discardStaged();
      }

      this.release = release;
      this.updateAvailable = true;
      this.lastUpdateInfo = {
        version: release.version,
        releaseDate: release.releaseDate,
        releaseNotes: release.releaseNotes,
        files: [{ url: release.asset.url, size: release.asset.size }],
      };
      console.log(`📋 Update available: ${current} → ${release.version}`);
      this.notifyRenderers("update-available", this.lastUpdateInfo);
      if (this.updateDownloaded) {
        this.notifyRenderers("update-downloaded", this.lastUpdateInfo);
      }
      return { updateAvailable: true, ...this.lastUpdateInfo };
    } catch (error) {
      this.reportError(error);
      throw error;
    }
  }

  async downloadUpdate() {
    if (this.isDev) {
      return { success: false, message: "Update downloads are disabled in development mode" };
    }
    if (this.isDownloading) {
      return { success: true, message: "Download already in progress" };
    }
    if (this.updateDownloaded) {
      return { success: true, message: "Update already downloaded. Ready to install." };
    }
    if (!this.release) {
      await this.checkForUpdates();
      if (!this.release) return { success: false, message: "No update available" };
    }

    this.isDownloading = true;
    // Run in the background; progress/completion/errors arrive as events,
    // matching how the renderer already handles electron-updater.
    this.performDownload().catch((err) => {
      this.isDownloading = false;
      this.discardStaged();
      this.reportError(err);
    });
    return { success: true, message: "Update download started" };
  }

  async performDownload() {
    const { version, asset } = this.release;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ss2-update-${version}-`));
    this.stagingDir = dir;
    const zipPath = path.join(dir, asset.name);

    console.log(`📥 Downloading ${asset.name}...`);
    const res = await fetch(asset.url, { headers: { "User-Agent": "SS2-Updater" } });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (HTTP ${res.status})`);
    }

    const total = Number(res.headers.get("content-length")) || asset.size || 0;
    let transferred = 0;
    let lastSent = 0;
    const out = fs.createWriteStream(zipPath);
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        transferred += value.length;
        if (!out.write(Buffer.from(value))) {
          await new Promise((r) => out.once("drain", r));
        }
        const now = Date.now();
        if (now - lastSent > 250) {
          lastSent = now;
          this.notifyRenderers("update-download-progress", {
            percent: total ? (transferred / total) * 100 : 0,
            transferred,
            total,
          });
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    if (total && transferred !== total) {
      throw new Error(`Download incomplete (${transferred} of ${total} bytes)`);
    }

    console.log("📦 Unpacking update...");
    const extractDir = path.join(dir, "extract");
    fs.mkdirSync(extractDir);
    await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
    fs.rmSync(zipPath, { force: true });

    const appPath = this.findApp(extractDir);
    if (!appPath) throw new Error("Update zip did not contain SS2.app");

    await this.verifyApp(appPath, version);

    this.stagedAppPath = appPath;
    this.isDownloading = false;
    this.updateDownloaded = true;
    this.installQuitHook();
    console.log(`✅ Update ${version} downloaded and verified`);
    this.notifyRenderers("update-download-progress", { percent: 100, transferred, total });
    this.notifyRenderers("update-downloaded", this.lastUpdateInfo);
  }

  findApp(root, depth = 0) {
    if (depth > 3) return null;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = path.join(root, entry.name);
      if (entry.name.endsWith(".app")) return p;
      const found = this.findApp(p, depth + 1);
      if (found) return found;
    }
    return null;
  }

  async verifyApp(appPath, expectedVersion) {
    const plist = path.join(appPath, "Contents", "Info.plist");
    const read = async (key) =>
      (await execFileAsync("/usr/bin/defaults", ["read", plist, key])).stdout.trim();

    const newVersion = await read("CFBundleShortVersionString");
    if (newVersion !== expectedVersion) {
      throw new Error(`Downloaded app is v${newVersion}, expected v${expectedVersion}`);
    }

    const running = this.getRunningBundlePath();
    if (running) {
      const runningId = (
        await execFileAsync("/usr/bin/defaults", [
          "read",
          path.join(running, "Contents", "Info.plist"),
          "CFBundleIdentifier",
        ])
      ).stdout.trim();
      const newId = await read("CFBundleIdentifier");
      if (runningId !== newId) {
        throw new Error(`Downloaded app has bundle id ${newId}, expected ${runningId}`);
      }
    }

    await execFileAsync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", appPath]).catch(() => {});
    try {
      await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", appPath]);
    } catch (err) {
      throw new Error(`Downloaded app failed signature check: ${err.stderr || err.message}`);
    }
    // Any valid signature passes --verify; also require the running app's
    // own signing identity so only Scott's builds can replace it.
    const requirement = running ? await this.designatedRequirement(running) : null;
    if (requirement) {
      try {
        await execFileAsync("/usr/bin/codesign", [
          "--verify",
          "--strict",
          "-R",
          requirement,
          appPath,
        ]);
      } catch {
        throw new Error("Downloaded app is signed by a different identity than this SS2");
      }
    }
  }

  async designatedRequirement(appPath) {
    try {
      const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", ["-d", "-r-", appPath]);
      return parseDesignatedRequirement(`${stdout}\n${stderr}`);
    } catch {
      return null;
    }
  }

  /**
   * Writes and launches a detached script that waits for this process to
   * exit, swaps the bundle (new copy first, so a failure never leaves the
   * user without an app), and optionally relaunches.
   */
  spawnSwapScript({ relaunch }) {
    const target = this.getRunningBundlePath();
    if (!target) throw new Error("Not running from an app bundle; can't install update");
    if (!this.stagedAppPath || !fs.existsSync(this.stagedAppPath)) {
      throw new Error("Downloaded update is missing; download it again");
    }

    const q = shellQuote;
    const logPath = path.join(os.tmpdir(), "ss2-update.log");
    const script = `#!/bin/bash
exec >>${q(logPath)} 2>&1
echo "=== $(date) installing update into ${target.replace(/[`$"\\]/g, "")} ==="
PID=${process.pid}
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$PID" 2>/dev/null; then echo "app still running; aborting"; exit 1; fi

TARGET=${q(target)}
NEW="$TARGET.new-$$"
OLD="$TARGET.old-$$"
rm -rf "$NEW"
if ! /usr/bin/ditto ${q(this.stagedAppPath)} "$NEW"; then
  echo "copy failed"; rm -rf "$NEW"; ${relaunch ? `open "$TARGET";` : ""} exit 1
fi
if mv "$TARGET" "$OLD" && mv "$NEW" "$TARGET"; then
  rm -rf "$OLD"
  echo "swap ok"
else
  echo "swap failed; restoring"
  [ -d "$OLD" ] && [ ! -d "$TARGET" ] && mv "$OLD" "$TARGET"
  rm -rf "$NEW"
fi
/usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
rm -rf ${q(this.stagingDir || "")}
${relaunch ? `open "$TARGET"` : ""}
rm -f "$0"
`;
    const scriptPath = path.join(os.tmpdir(), `ss2-install-update-${process.pid}.sh`);
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    const child = spawn("/bin/bash", [scriptPath], { detached: true, stdio: "ignore" });
    child.unref();
    console.log(`🔄 Update installer launched (log: ${logPath})`);
  }

  /** Mirrors electron-updater's autoInstallOnAppQuit. */
  installQuitHook() {
    if (this.quitHookInstalled) return;
    this.quitHookInstalled = true;
    const { app } = require("electron");
    app.on("will-quit", () => {
      if (this.updateDownloaded && !this.isInstalling) {
        try {
          this.isInstalling = true;
          this.spawnSwapScript({ relaunch: false });
        } catch (err) {
          console.error("❌ Install-on-quit failed:", err);
        }
      }
    });
  }

  async installUpdate() {
    if (this.isDev) {
      return { success: false, message: "Update installation is disabled in development mode" };
    }
    if (!this.updateDownloaded) {
      return { success: false, message: "No update available to install" };
    }
    if (this.isInstalling) {
      return { success: false, message: "Update installation already in progress" };
    }

    this.isInstalling = true;
    try {
      this.spawnSwapScript({ relaunch: true });
    } catch (error) {
      this.isInstalling = false;
      this.reportError(error);
      throw error;
    }

    console.log("🔄 Quitting to install update...");
    const { app, BrowserWindow } = require("electron");
    // Remove listeners that keep windows/app alive so the quit goes through.
    app.removeAllListeners("window-all-closed");
    BrowserWindow.getAllWindows().forEach((win) => win.removeAllListeners("close"));
    setTimeout(() => app.quit(), 100);
    // If something still blocks the quit, force it so the installer can run.
    setTimeout(() => app.exit(0), 8000);

    return { success: true, message: "Update installation started" };
  }

  discardStaged() {
    if (this.stagingDir) {
      fs.rmSync(this.stagingDir, { recursive: true, force: true });
    }
    this.stagingDir = null;
    this.stagedAppPath = null;
    this.updateDownloaded = false;
  }

  async getAppVersion() {
    const { app } = require("electron");
    return { version: app.getVersion() };
  }

  async getUpdateStatus() {
    return {
      updateAvailable: this.updateAvailable,
      updateDownloaded: this.updateDownloaded,
      isDevelopment: this.isDev,
    };
  }

  async getUpdateInfo() {
    return this.lastUpdateInfo;
  }

  get autoUpdateEnabled() {
    return process.env.SS2_AUTO_UPDATE !== "0";
  }

  t(key, options) {
    return require("./helpers/i18nMain").i18nMain.t(key, options);
  }

  notify(title, body) {
    try {
      const { Notification } = require("electron");
      if (Notification?.isSupported?.()) new Notification({ title, body }).show();
    } catch {}
  }

  // "Updated to x.y.z" on the first launch of a new version.
  announceIfUpdated() {
    try {
      const { app } = require("electron");
      const file = path.join(app.getPath("userData"), "last-run-version.json");
      const current = app.getVersion();
      let previous = null;
      try {
        previous = JSON.parse(fs.readFileSync(file, "utf8")).version;
      } catch {}
      if (previous !== current) fs.writeFileSync(file, JSON.stringify({ version: current }));
      if (previous && isNewer(current, previous)) {
        console.log(`✅ Updated from ${previous} to ${current}`);
        this.notify(
          this.t("updaterNotice.updated.title", { version: current }),
          this.t("updaterNotice.updated.body", { previous })
        );
        this.justUpdatedFrom = previous;
      }
    } catch (err) {
      console.warn("Could not record the running version:", err.message || err);
    }
  }

  // Quiet check: finds and downloads an update without showing errors; the
  // will-quit hook installs it.
  async backgroundCheck() {
    if (this.isDownloading || this.isInstalling) return;
    // macOS clears old temp files; a staged copy that vanished is re-downloaded.
    if (this.updateDownloaded && !(this.stagedAppPath && fs.existsSync(this.stagedAppPath)))
      this.discardStaged();
    this.isStartupCheck = true;
    try {
      const result = await this.checkForUpdates();
      if (!result?.updateAvailable || !this.autoUpdateEnabled || this.updateDownloaded) return;
      const version = this.release.version;
      await new Promise((resolve, reject) => {
        this.isDownloading = true;
        this.performDownload().then(resolve, (err) => {
          this.isDownloading = false;
          this.discardStaged();
          reject(err);
        });
      });
      if (this.announcedReady !== version) {
        this.announcedReady = version;
        this.notify(
          this.t("updaterNotice.ready.title", { version }),
          this.t("updaterNotice.ready.body")
        );
      }
    } catch (err) {
      console.warn("Background update check failed:", err.message || err);
    } finally {
      this.isStartupCheck = false;
    }
  }

  checkForUpdatesOnStartup() {
    if (this.isDev) return;
    this.announceIfUpdated();
    setTimeout(() => {
      console.log("🔄 Checking for updates on startup...");
      void this.backgroundCheck();
    }, STARTUP_CHECK_DELAY_MS);
    this.checkTimer = setInterval(() => void this.backgroundCheck(), CHECK_INTERVAL_MS);
    this.checkTimer.unref?.();
  }

  cleanup() {
    clearInterval(this.checkTimer);
    // Keep a downloaded update staged: the will-quit hook installs it.
    if (!this.updateDownloaded && this.stagingDir && !this.isDownloading) {
      this.discardStaged();
    }
  }
}

UpdateManager._internal = { isNewer, parseVersion, parseDesignatedRequirement };

module.exports = UpdateManager;
