const path = require("path");

const SEPARATOR = " / ";

/**
 * Short, distinct labels for folder paths: the parent and the folder
 * ("TenenbaumAI / docs"), with more parent folders added only where two
 * labels would still be the same. Returns labels in input order.
 */
function folderLabels(paths) {
  const parts = paths.map((p) =>
    String(p || "")
      .split(path.sep)
      .filter(Boolean)
  );
  const depth = parts.map((segments) => Math.min(2, Math.max(segments.length, 1)));
  const label = (i) => parts[i].slice(-depth[i]).join(SEPARATOR) || path.sep;

  for (;;) {
    const groups = new Map();
    parts.forEach((_, i) => {
      const key = label(i);
      groups.set(key, [...(groups.get(key) || []), i]);
    });
    let grew = false;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      for (const i of members) {
        if (depth[i] < parts[i].length) {
          depth[i] += 1;
          grew = true;
        }
      }
    }
    if (!grew) return parts.map((_, i) => label(i));
  }
}

/** Adds a `label` to each pinned folder ({ path, ... }). */
function withFolderLabels(folders) {
  const labels = folderLabels(folders.map((folder) => folder.path));
  return folders.map((folder, i) => ({ ...folder, label: labels[i] }));
}

module.exports = { folderLabels, withFolderLabels, SEPARATOR };
