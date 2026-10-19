const fs = require("fs");
const path = require("path");
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function regularJson(file, limit) {
  if (!fs.lstatSync(file).isFile()) throw new Error("Expected a regular call file");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > limit) throw new Error("Call data exceeds access limit");
    return JSON.parse(fs.readFileSync(descriptor, "utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}
// Read only. MeetingStore's constructor repairs recording states and must not run in MCP.
function createCallReader(directory) {
  if (!fs.lstatSync(directory).isDirectory()) throw new Error("Expected a regular call directory");
  const root = fs.realpathSync(directory);
  return (id) => {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid call ID");
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory())
      throw new Error("Call directory changed");
    const index = regularJson(path.join(root, "index.json"), 4 * 1024 ** 2);
    if (!Array.isArray(index.ids) || !index.ids.includes(id))
      throw new Error("Call is not registered");
    const callDirectory = path.join(root, id);
    if (
      !fs.lstatSync(callDirectory).isDirectory() ||
      fs.realpathSync(callDirectory) !== callDirectory
    )
      throw new Error("Expected a regular call directory");
    const call = regularJson(path.join(callDirectory, "session.json"), 8 * 1024 ** 2);
    if (call.id !== id) throw new Error("Invalid call identity");
    return call;
  };
}
module.exports = { createCallReader };
