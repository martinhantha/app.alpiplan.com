import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CapacitorConfig } from "@capacitor/cli";

function loadEnvFile(file: string) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// cap sync läuft in apps/mobile-shell; Root-.env liegt zwei Ebenen höher.
loadEnvFile(resolve(process.cwd(), "../../.env"));
loadEnvFile(resolve(process.cwd(), ".env"));

const serverUrl = process.env.CAPACITOR_SERVER_URL?.replace(/\/+$/, "");

/** Store version. `pnpm deploy:main` bumps versionCode and versionName and tags the release. */
export const nativeAppVersion = {
  versionCode: 17,
  versionName: "1.0.16",
} as const;

const config: CapacitorConfig = {
  appId: "at.alpiplan.app",
  appName: "Alpiplan",
  webDir: "www",
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith("http://"),
        androidScheme: "https",
        errorPath: "offline.html",
      }
    : {
        androidScheme: "https",
        errorPath: "offline.html",
      },
  android: {
    allowMixedContent: Boolean(serverUrl?.startsWith("http://")),
  },
  plugins: {
    // Remote server.url uses the WebView cookie jar for httpOnly auth cookies.
    // CapacitorCookies patching can drop those sessions when the app is backgrounded.
    CapacitorCookies: {
      enabled: false,
    },
  },
};

export default config;
