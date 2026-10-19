import i18n, { type BackendModule, type Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import { PROMPTS_BY_LOCALE } from "./locales/prompts";
import enTranslation from "./locales/en/translation.json";

export const SUPPORTED_UI_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "ru",
  "ja",
  "zh-CN",
  "zh-TW",
] as const;
export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export function normalizeUiLanguage(language: string | null | undefined): UiLanguage {
  const candidate = (language || "").trim();

  // Check full language-region code first (e.g. "zh-CN", "zh-TW")
  const normalized = candidate.replace("_", "-");
  const fullMatch = SUPPORTED_UI_LANGUAGES.find(
    (lang) => lang.toLowerCase() === normalized.toLowerCase()
  );
  if (fullMatch) return fullMatch;

  // Fall back to base language code (e.g. "en" from "en-US")
  const base = candidate.split("-")[0].split("_")[0].toLowerCase() as UiLanguage;
  if (SUPPORTED_UI_LANGUAGES.includes(base)) {
    return base;
  }

  return "en";
}

// Keep prompt lookup synchronous even while a UI language change is loading.
// Dictation uses the language captured when recording began.
const resources: Resource = Object.fromEntries(
  SUPPORTED_UI_LANGUAGES.map((locale) => [locale, { prompts: PROMPTS_BY_LOCALE[locale] }])
);
resources.en.translation = enTranslation;

// Vite emits these as local chunks, so language switching stays fully offline
// in a packaged Electron app without parsing every UI dictionary at startup.
const translationLoaders = {
  es: () => import("./locales/es/translation.json"),
  fr: () => import("./locales/fr/translation.json"),
  de: () => import("./locales/de/translation.json"),
  pt: () => import("./locales/pt/translation.json"),
  it: () => import("./locales/it/translation.json"),
  ru: () => import("./locales/ru/translation.json"),
  ja: () => import("./locales/ja/translation.json"),
  "zh-CN": () => import("./locales/zh-CN/translation.json"),
  "zh-TW": () => import("./locales/zh-TW/translation.json"),
};

const localTranslations: BackendModule = {
  type: "backend",
  init() {},
  read(language, namespace, callback) {
    const locale = normalizeUiLanguage(language);
    if (namespace === "prompts") {
      callback(null, PROMPTS_BY_LOCALE[locale]);
    } else if (locale === "en") {
      callback(null, enTranslation);
    } else {
      translationLoaders[locale]().then(
        (module) => callback(null, module.default),
        (error) => callback(error, false)
      );
    }
  },
};

const browserLanguage =
  typeof navigator !== "undefined" ? navigator.language || navigator.languages?.[0] : undefined;

const storageLanguage =
  typeof window !== "undefined" ? window.localStorage.getItem("uiLanguage") : undefined;

const initialLanguage = normalizeUiLanguage(storageLanguage || browserLanguage || "en");

export const i18nReady = i18n
  .use(localTranslations)
  .use(initReactI18next)
  .init({
    resources,
    partialBundledLanguages: true,
    supportedLngs: [...SUPPORTED_UI_LANGUAGES],
    load: "currentOnly",
    lng: initialLanguage,
    fallbackLng: "en",
    ns: ["translation", "prompts"],
    defaultNS: "translation",
    interpolation: {
      escapeValue: false,
    },
    returnEmptyString: true,
    returnNull: false,
  });

export default i18n;
