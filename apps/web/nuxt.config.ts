import { execSync } from "node:child_process";

/** Im Docker-Build fehlt `.git`; dort liefert SOURCE_COMMIT (Coolify / deploy:local) zur Laufzeit den Commit. */
function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

export default defineNuxtConfig({
  modules: ["@nuxt/ui", "@nuxtjs/i18n"],
  i18n: {
    restructureDir: false,
    locales: [
      { code: "de", name: "Deutsch", file: "de.json" },
      { code: "en", name: "English", file: "en.json" },
      { code: "it", name: "Italiano", file: "it.json" },
    ],
    defaultLocale: "de",
    lazy: true,
    langDir: "locales",
    bundle: {
      optimizeTranslationDirective: false,
    },
    strategy: "no_prefix",
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: "alpiplan.locale",
      fallbackLocale: "de",
    },
  },
  css: ["~/assets/css/main.css"],
  devtools: { enabled: true },
  compatibilityDate: "2025-04-01",
  experimental: {
    /** Neuer Web-Deploy → `app:manifest:update` (Hinweis + Reload beim nächsten Seitenwechsel). */
    checkOutdatedBuildInterval: 5 * 60 * 1000,
  },
  runtimeConfig: {
    /** HttpOnly-Session-Cookie (nur Server) */
    authCookie: process.env.AUTH_COOKIE_NAME ?? "alpiplan_at",
    /**
     * Update-Hinweis kommt automatisch aus Play Store / App Store.
     * Min-`versionCode` (apps/mobile-shell/capacitor.config.ts) erzwingt das Update, 0 = aus.
     * Override per Env, z. B. NUXT_APP_UPDATE_ANDROID_MIN_VERSION_CODE=9.
     */
    appUpdate: {
      androidMinVersionCode: 0,
      iosMinVersionCode: 0,
      /** Apple-ID der App (Zahl aus https://apps.apple.com/app/id…) */
      iosAppStoreId: "",
      /** App-Store-Land für die Versionsabfrage (ISO-2, z. B. "it") */
      iosCountry: "",
    },
    build: {
      commit: process.env.SOURCE_COMMIT || gitCommit(),
      builtAt: new Date().toISOString(),
    },
    public: {
      demoEmail: process.env.NUXT_PUBLIC_DEMO_EMAIL ?? "demo@alpiplan.local",
      /** Anbietername auf der Support-Seite */
      legalName: process.env.NUXT_PUBLIC_LEGAL_NAME ?? "Alpiplan",
      /** Webseite mit der Datenschutzerklärung */
      websiteUrl: process.env.NUXT_PUBLIC_WEBSITE_URL ?? "https://alpiplan.com",
      supportEmail: process.env.NUXT_PUBLIC_SUPPORT_EMAIL ?? "support@alpiplan.com",
    },
  },
  nitro: {
    rollupConfig: {
      external: ["@prisma/client", ".prisma/client"],
    },
    routeRules: {
      "/support": {
        headers: { "cache-control": "public, max-age=3600" },
      },
      "/api/app-version": {
        headers: { "cache-control": "no-store" },
      },
      "/sw.js": {
        headers: { "cache-control": "no-cache", "service-worker-allowed": "/" },
      },
      "/api/v1/tenants/**/events": {
        headers: {
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      },
    },
  },
  vite: {
    optimizeDeps: {
      include: [
        "@capacitor/core",
        "@capacitor/app",
        "@capawesome/capacitor-app-update",
        "@capacitor-community/contacts",
        "@alpiplan/capacitor-appointments-widget",
        "@alpiplan/capacitor-call-hints",
        "@internationalized/date",
      ],
    },
    resolve: {
      dedupe: [
        "vue",
        "@vue/runtime-core",
        "@vue/runtime-dom",
        "@vue/server-renderer",
        "@vue/shared",
      ],
    },
  },
  // Reka (Nuxt UI) als CJS aus node_modules lädt sonst ein anderes @vue/runtime-core als der SSR-Bundle.
  ssr: {
    noExternal: [
      "reka-ui",
      "vaul-vue",
      "@alpiplan/device-capabilities",
      "@alpiplan/capacitor-appointments-widget",
      "@alpiplan/capacitor-call-hints",
    ],
  },
  app: {
    head: {
      title: "Alpiplan",
      meta: [
        { name: "description", content: "Alpiplan — Termine planen, erfassen und im Team abstimmen" },
        { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
        { name: "theme-color", content: "#f7f6f3", media: "(prefers-color-scheme: light)" },
        { name: "theme-color", content: "#100e18", media: "(prefers-color-scheme: dark)" },
        { name: "mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-title", content: "Alpiplan" },
        { name: "apple-mobile-web-app-status-bar-style", content: "default" },
      ],
      link: [
        {
          rel: "preload",
          href: "/fonts/inter-latin-wght-normal.woff2",
          as: "font",
          type: "font/woff2",
          crossorigin: "",
        },
        { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
        { rel: "icon", type: "image/png", href: "/favicon.png" },
        { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
        { rel: "manifest", href: "/manifest.webmanifest" },
      ],
    },
  },
});
