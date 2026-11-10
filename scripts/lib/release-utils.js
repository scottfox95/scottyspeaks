/**
 * Pure helpers for scripts/publish-update.js, kept side-effect free so they
 * can be unit tested (tests/release-scripts.test.cjs).
 */

const BUMP_KINDS = ["patch", "minor", "major", "none"];

function parsePublishArgs(argv) {
  const opts = { kind: "patch", dryRun: false, replace: false };
  let kindSeen = false;
  for (const raw of argv) {
    const arg = String(raw).trim();
    if (arg === "--dry-run" || arg === "-n") opts.dryRun = true;
    else if (arg === "--replace") opts.replace = true;
    else if (BUMP_KINDS.includes(arg.toLowerCase()) && !kindSeen) {
      opts.kind = arg.toLowerCase();
      kindSeen = true;
    } else {
      throw new Error(
        `Unknown argument "${arg}". Usage: npm run publish -- [patch|minor|major|none] [--dry-run] [--replace]`
      );
    }
  }
  return opts;
}

function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || "").trim());
  if (!m) throw new Error(`"${version}" is not a plain x.y.z version`);
  return m.slice(1).map(Number);
}

function nextVersion(current, kind) {
  const [maj, min, pat] = parseVersion(current);
  switch (kind) {
    case "none":
      return `${maj}.${min}.${pat}`;
    case "major":
      return `${maj + 1}.0.0`;
    case "minor":
      return `${maj}.${min + 1}.0`;
    case "patch":
      return `${maj}.${min}.${pat + 1}`;
    default:
      throw new Error(`Unknown bump kind "${kind}"`);
  }
}

/** Numeric x.y.z comparison: 1 if a > b, -1 if a < b, 0 if equal. */
function compareVersions(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Returns package.json text with its version set; formatting matches npm. */
function withPackageVersion(text, version) {
  const pkg = JSON.parse(text);
  pkg.version = version;
  return JSON.stringify(pkg, null, 2) + "\n";
}

/** Returns package-lock.json text with the root package version set. */
function withLockfileVersion(text, version) {
  const lock = JSON.parse(text);
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
  return JSON.stringify(lock, null, 2) + "\n";
}

/** `codesign -d -r-` prints "designated => <requirement>" on stdout or stderr. */
function parseDesignatedRequirement(output) {
  const match = String(output || "").match(/designated => (.+)/);
  return match ? match[1].trim() : null;
}

/**
 * Problems that must block a release before anything is bumped or built.
 * Each input is a plain fact gathered by the caller.
 */
function preflightProblems({ porcelain, signing, ghAuthed, tagExists, replace, tag }) {
  const problems = [];
  const dirty = String(porcelain || "")
    .split("\n")
    .filter((l) => l.trim());
  if (dirty.length) {
    const shown = dirty.slice(0, 10).map((l) => `    ${l}`);
    if (dirty.length > 10) shown.push(`    ... and ${dirty.length - 10} more`);
    problems.push(
      ["Working tree is not clean (commit or stash first, untracked files included):", ...shown].join("\n")
    );
  }
  if (signing && signing.action === "fail") problems.push(signing.error);
  if (ghAuthed === false) problems.push("GitHub CLI is not logged in (run `gh auth login`).");
  if (tagExists && !replace) {
    problems.push(
      `${tag} is already published. Bump the version, or pass --replace to delete and recreate that release.`
    );
  }
  return problems;
}

module.exports = {
  BUMP_KINDS,
  parsePublishArgs,
  nextVersion,
  compareVersions,
  withPackageVersion,
  withLockfileVersion,
  parseDesignatedRequirement,
  preflightProblems,
};
