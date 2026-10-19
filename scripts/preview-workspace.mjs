// Generate a disposable entry for Vite. The real app's production entry never
// imports these fixtures, and no native Electron API is available in this page.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(scripts, "../src/temp/workspace-preview");
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(
  path.join(scripts, "fixtures/workspace-preview.jsx"),
  path.join(destination, "main.jsx")
);
fs.writeFileSync(
  path.join(destination, "index.html"),
  '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SS2 Preview</title></head><body><div id="root"></div><script type="module" src="./main.jsx"></script></body></html>'
);
console.log("Preview entry: /temp/workspace-preview/index.html#meetings");
console.log("Start the normal renderer dev server with your review host passed via --host.");
