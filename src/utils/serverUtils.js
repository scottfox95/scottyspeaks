const fs = require("fs");
const net = require("net");
const path = require("path");
const { killProcess } = require("./process");

const GRACEFUL_STOP_TIMEOUT_MS = 5000;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      // Resolve only after the probe socket is fully released, so the caller
      // can't hand the port to a child that binds before we let go.
      server.close(() => resolve(true));
    });
    // Probe the wildcard address, not 127.0.0.1: the servers we launch bind
    // to 0.0.0.0, and Node's default SO_REUSEADDR lets a loopback-only probe
    // succeed while a stale process still holds *:port — reporting the port
    // free and then killing the child with EADDRINUSE.
    server.listen(port, "0.0.0.0");
  });
}

async function findAvailablePort(rangeStart, rangeEnd) {
  for (let port = rangeStart; port <= rangeEnd; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${rangeStart}-${rangeEnd}`);
}

function resolveBinaryPath(binaryName) {
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "bin", binaryName));
  }

  const projectBinDir = path.resolve(__dirname, "..", "..", "resources", "bin");
  candidates.push(path.join(projectBinDir, binaryName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        fs.statSync(candidate);
        return candidate;
      } catch {
        // Can't access binary
      }
    }
  }

  return null;
}

async function gracefulStopProcess(proc) {
  killProcess(proc, "SIGTERM");

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (proc) killProcess(proc, "SIGKILL");
      resolve();
    }, GRACEFUL_STOP_TIMEOUT_MS);

    if (proc) {
      proc.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    } else {
      clearTimeout(timeout);
      resolve();
    }
  });
}

module.exports = {
  findAvailablePort,
  isPortAvailable,
  resolveBinaryPath,
  gracefulStopProcess,
};
