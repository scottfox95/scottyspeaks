// Packaged file:// locale coverage: cold non-English launch, offline switching,
// cached dictionaries, and synchronous dictation prompts during UI changes.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-locales-ui-"));
const name = `.locale-smoke-${process.pid}`;
const html = path.join(root, "src", `${name}.html`);
const entry = path.join(root, "src", `${name}.js`);
const output = path.join(temp, "bundle");
const languages = ["en", "es", "fr", "de", "pt", "it", "ru", "ja", "zh-CN", "zh-TW"];
app.setPath("userData", path.join(temp, "profile"));
let window;

const js = (source) => window.webContents.executeJavaScript(source, true);
const waitFor = async (check, label) => {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
};
const translation = (language) =>
  require(path.join(root, "src/locales", language, "translation.json")).common.cancel;

app.whenReady().then(async () => {
  try {
    fs.writeFileSync(
      html,
      `<html><body><div id="root"></div><script>
      localStorage.setItem('uiLanguage', new URL(location.href).searchParams.get('lang') || 'en');
      window.localeFrames = [];
      new MutationObserver(() => window.localeFrames.push(document.getElementById('root').textContent))
        .observe(document.getElementById('root'), {subtree: true, childList: true, characterData: true});
      </script><script type="module" src="./${name}.js"></script></body></html>`
    );
    fs.writeFileSync(
      entry,
      `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { I18nextProvider, useTranslation } from 'react-i18next';
      import i18n, { i18nReady } from './i18n';
      function Label() { const { t } = useTranslation(); return React.createElement('button', null, t('common.cancel')); }
      i18nReady.then(() => {
        window.localeTest = {
          change: (language) => i18n.changeLanguage(language).then(() => i18n.language),
          loaded: (language) => i18n.hasResourceBundle(language, 'translation'),
          prompt: (language) => i18n.getFixedT(language, 'prompts')('fullPrompt'),
        };
        createRoot(document.getElementById('root')).render(
          React.createElement(I18nextProvider, { i18n }, React.createElement(Label))
        );
      });`
    );
    const { build } = await import("vite");
    await build({
      configFile: false,
      root: path.join(root, "src"),
      base: "./",
      logLevel: "error",
      build: { outDir: output, emptyOutDir: true, rollupOptions: { input: html } },
    });
    window = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    const errors = [];
    window.webContents.on("console-message", ({ level, message }) => {
      if (level === "error" && !message.includes("Electron Security Warning")) errors.push(message);
    });
    const readText = () => js("document.getElementById('root').textContent");
    const launch = async (language) => {
      await window.loadFile(path.join(output, `${name}.html`), { query: { lang: language } });
      await waitFor(async () => (await readText()) === translation(language), `${language} launch`);
      const frames = await js("window.localeFrames");
      assert(frames.length > 0, "Rendered localized content");
      assert(
        frames.every((text) => text === translation(language)),
        "No keys or English flash"
      );
    };

    await launch("en");
    for (const language of languages) {
      assert.equal(
        await js(`window.localeTest.loaded(${JSON.stringify(language)})`),
        language === "en",
        `Only English UI dictionary loads at English startup: ${language}`
      );
      assert.equal(
        await js(`window.localeTest.prompt(${JSON.stringify(language)})`),
        require(path.join(root, "src/locales", language, "prompts.json")).fullPrompt,
        `Prompt is synchronous before UI dictionary loads: ${language}`
      );
    }
    for (const language of languages.slice(1)) {
      assert.equal(await js(`window.localeTest.change(${JSON.stringify(language)})`), language);
      await waitFor(async () => (await readText()) === translation(language), `${language} switch`);
    }
    const resourceCount = await js("performance.getEntriesByType('resource').length");
    await js("window.localeTest.change('fr')");
    await waitFor(async () => (await readText()) === translation("fr"), "cached French switch");
    assert.equal(await js("performance.getEntriesByType('resource').length"), resourceCount);

    await launch("ja");
    assert.equal(await js("window.localeTest.loaded('ja')"), true);
    assert.equal(await js("window.localeTest.loaded('fr')"), false);
    assert.deepEqual(errors, [], "Packaged renderer has no runtime errors");
    console.log(
      "Packaged locale smoke passed: lazy UI dictionaries, 10 languages, no launch flash, synchronous prompts."
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    fs.rmSync(html, { force: true });
    fs.rmSync(entry, { force: true });
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
