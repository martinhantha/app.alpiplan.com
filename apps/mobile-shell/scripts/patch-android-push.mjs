import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const sourceJson =
  [
    resolve(root, "google-services.json"),
    resolve(root, "../../google-services.json"),
  ].find((file) => existsSync(file)) ?? null;

if (!sourceJson) process.exit(0);

const appJson = resolve(root, "android/app/google-services.json");
const appGradle = resolve(root, "android/app/build.gradle");
const rootGradle = resolve(root, "android/build.gradle");
if (!existsSync(appGradle) || !existsSync(rootGradle)) process.exit(0);

copyFileSync(sourceJson, appJson);

let app = readFileSync(appGradle, "utf8");
let appChanged = false;
if (!app.includes("firebase-messaging")) {
  const next = app.replace(
    /dependencies\s*\{/,
    "dependencies {\n    implementation 'com.google.firebase:firebase-messaging:24.1.0'",
  );
  if (next !== app) {
    app = next;
    appChanged = true;
  }
}
if (!app.includes("com.google.gms.google-services")) {
  app = `${app.trimEnd()}\n\napply plugin: 'com.google.gms.google-services'\n`;
  appChanged = true;
}
if (appChanged) writeFileSync(appGradle, app);

let rootBuild = readFileSync(rootGradle, "utf8");
if (!rootBuild.includes("com.google.gms:google-services")) {
  rootBuild = rootBuild.replace(
    /dependencies\s*\{/,
    "dependencies {\n        classpath 'com.google.gms:google-services:4.4.2'",
  );
  writeFileSync(rootGradle, rootBuild);
}

// Belt and braces next to the plugin's consumer rules: keep the Firebase classes the
// push plugin reaches via reflection, otherwise a minified release build gets no token.
const proguard = resolve(root, "android/app/proguard-rules.pro");
const keepRules = [
  "# Alpiplan push: FirebaseMessaging is used via reflection (see capacitor-call-hints consumer-rules.pro)",
  "-keep class com.google.firebase.messaging.FirebaseMessaging { *; }",
  "-keep class com.google.android.gms.tasks.Task { *; }",
  "-keep class com.google.android.gms.tasks.OnCompleteListener { *; }",
].join("\n");
const existingRules = existsSync(proguard) ? readFileSync(proguard, "utf8") : "";
if (!existingRules.includes("com.google.firebase.messaging.FirebaseMessaging")) {
  writeFileSync(proguard, `${existingRules.trimEnd()}\n\n${keepRules}\n`);
}

console.log("Patched Android Firebase Cloud Messaging for background push.");
