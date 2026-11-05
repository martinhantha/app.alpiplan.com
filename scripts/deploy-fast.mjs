#!/usr/bin/env node
/**
 * Schneller Hotfix-Deploy ohne Server-Build:
 *
 *   pnpm deploy:fast [--dry-run] [--migrate] [--no-push] [--no-logs]
 *
 * 1. Prüft den Git-Stand und pusht den aktuellen Branch, falls er vor origin liegt.
 * 2. Startet Docker Desktop, falls der lokale Docker nicht läuft, und wartet darauf.
 * 3. Baut das Web-Image lokal für den Server und startet den Coolify-Container
 *    damit neu (scripts/deploy-local.mjs, Server-Context + Build-Context vorbelegt).
 * 4. Zeigt danach die Push-/Assistant-/Fehlerzeilen des neuen Containers.
 *
 * Contexts anpassen über DEPLOY_CONTEXT (Server) und DEPLOY_BUILD_CONTEXT (lokal).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_CONTEXT = process.env.DEPLOY_CONTEXT ?? "avelom.cloud";
const BUILD_CONTEXT = process.env.DEPLOY_BUILD_CONTEXT ?? "desktop-linux";
const SERVICE = "web-alpiplan";
const DOCKER_START_TIMEOUT_MS = 120_000;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
if (flag("help") || flag("h")) {
  console.log(`pnpm deploy:fast [Optionen]

  --dry-run     nur bauen und prüfen, nichts hochladen
  --migrate     prisma migrate deploy vor dem Neustart ausführen
  --no-push     Branch nicht automatisch pushen
  --no-logs     nach dem Deploy keine Logzeilen anzeigen

  Server-Context: ${SERVER_CONTEXT}   (DEPLOY_CONTEXT)
  Build-Context:  ${BUILD_CONTEXT}   (DEPLOY_BUILD_CONTEXT)`);
  process.exit(0);
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const step = (msg) => console.log(`\n${bold("▸")} ${bold(msg)}`);
const info = (msg) => console.log(`  ${msg}`);
const fail = (msg) => {
  console.error(`\n\x1b[31m✖\x1b[0m ${msg}`);
  process.exit(1);
};

function run(cmd, cmdArgs, { capture = false, check = true } = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: REPO_ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: process.env,
  });
  if (check && result.status !== 0) {
    fail(`${cmd} ${cmdArgs.join(" ")} ist fehlgeschlagen${capture && result.stderr ? `:\n${result.stderr.trim()}` : "."}`);
  }
  return capture ? (result.stdout ?? "").trim() : "";
}
const succeeds = (cmd, cmdArgs) =>
  spawnSync(cmd, cmdArgs, { cwd: REPO_ROOT, stdio: "ignore", env: process.env }).status === 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Git
step("Git prüfen");
if (run("git", ["status", "--porcelain"], { capture: true })) {
  fail("Arbeitsverzeichnis ist nicht sauber. Erst committen oder stashen.");
}
const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
run("git", ["fetch", "--quiet", "origin"]);
if (!succeeds("git", ["rev-parse", "--verify", "--quiet", "@{u}"])) {
  fail(`Branch ${branch} hat keinen Upstream. Einmal mit "git push -u origin ${branch}" pushen.`);
}
const ahead = Number(run("git", ["rev-list", "--count", "@{u}..HEAD"], { capture: true }));
const behind = Number(run("git", ["rev-list", "--count", "HEAD..@{u}"], { capture: true }));
if (behind > 0) fail(`${branch} liegt ${behind} Commit(s) hinter origin. Erst "git pull".`);
if (ahead > 0) {
  if (flag("no-push")) fail(`${branch} liegt ${ahead} Commit(s) vor origin. Pushen oder ohne --no-push starten.`);
  info(`${branch} liegt ${ahead} Commit(s) vor origin, pushe …`);
  run("git", ["push", "--quiet", "origin", branch]);
}
if (branch !== "main") info(`\x1b[33m!\x1b[0m Coolify deployt "main", ausgecheckt ist "${branch}".`);
info(`${branch} @ ${run("git", ["rev-parse", "--short", "HEAD"], { capture: true })} ${dim(run("git", ["log", "-1", "--format=%s"], { capture: true }))}`);

// 2. Docker Desktop
step("Lokalen Docker prüfen");
const localDockerUp = () => succeeds("docker", ["--context", BUILD_CONTEXT, "info"]);
if (!localDockerUp()) {
  if (process.platform !== "darwin") fail(`Docker-Context "${BUILD_CONTEXT}" nicht erreichbar.`);
  info("Docker Desktop läuft nicht, starte …");
  run("open", ["-a", "Docker"]);
  const deadline = Date.now() + DOCKER_START_TIMEOUT_MS;
  while (!localDockerUp()) {
    if (Date.now() > deadline) fail("Docker Desktop ist nicht rechtzeitig gestartet.");
    await sleep(3000);
  }
}
info(`Build-Context ${BUILD_CONTEXT} bereit, Server-Context ${SERVER_CONTEXT}.`);
if (!succeeds("docker", ["--context", SERVER_CONTEXT, "info"])) {
  fail(`Server-Context "${SERVER_CONTEXT}" nicht erreichbar (SSH?).`);
}

// 3. Bauen + Deploy
step(flag("dry-run") ? "Lokal bauen (Probelauf)" : "Lokal bauen und deployen");
const passthrough = ["--yes", "--context", SERVER_CONTEXT, "--build-context", BUILD_CONTEXT];
if (flag("dry-run")) passthrough.push("--dry-run");
if (flag("migrate")) passthrough.push("--migrate");
run("node", ["scripts/deploy-local.mjs", ...passthrough]);

// 4. Logs
if (flag("dry-run") || flag("no-logs")) process.exit(0);
step("Logzeilen des neuen Containers (push / assistant / Fehler)");
await sleep(5000);
const container = run(
  "docker",
  ["--context", SERVER_CONTEXT, "ps", "--filter", `name=${SERVICE}`, "--format", "{{.Names}}"],
  { capture: true },
).split("\n")[0];
if (!container) fail("Container nach dem Deploy nicht gefunden.");
const logs = run("docker", ["--context", SERVER_CONTEXT, "logs", "--since", "2m", container], { capture: true, check: false });
const lines = logs
  .split("\n")
  .filter((line) => /\[push\]|\[assistant\]|error|migrat/i.test(line) && !/Duplicated imports/.test(line));
info(lines.length ? lines.join("\n  ") : dim("(noch keine relevanten Zeilen)"));
info(dim(`Weiter beobachten: docker --context ${SERVER_CONTEXT} logs -f ${container} 2>&1 | grep '\\[push\\]'`));
