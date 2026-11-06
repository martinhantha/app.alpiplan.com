#!/usr/bin/env node
/**
 * Prüft vor einem Deploy, ob alles passt (wird auch von der VS-Code-/Cursor-
 * Erweiterung unter tools/vscode-deploy verwendet).
 *
 *   pnpm deploy:check [--json] [--offline]
 *
 * --json      Ergebnis maschinenlesbar ausgeben
 * --offline   Server-Checks (SSH) überspringen
 *
 * Exit-Code 1, wenn mindestens ein Check "error" ist.
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import process from "node:process";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_CONTEXT = process.env.DEPLOY_CONTEXT ?? "avelom.cloud";
const BUILD_CONTEXT = process.env.DEPLOY_BUILD_CONTEXT ?? "desktop-linux";
const SERVICE = "web-alpiplan";
const LOCALES_DIR = "apps/web/locales";
const BASE_LOCALE = "de";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const offline = args.includes("--offline");

function exec(cmd, cmdArgs, { timeout = 30_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { cwd: REPO_ROOT, timeout, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout ?? "").trim(), stderr: (stderr ?? "").trim() || err?.message || "" });
    });
  });
}
const git = (...a) => exec("git", a);

const result = (id, label, status, detail = "", hint = "") => ({ id, label, status, detail, hint });

async function checkGit() {
  const checks = [];
  const status = await git("status", "--porcelain");
  const dirty = status.stdout.split("\n").filter(Boolean);
  checks.push(
    dirty.length
      ? result(
          "git-clean",
          "Arbeitsverzeichnis sauber",
          "error",
          `${dirty.length} geänderte Datei(en): ${dirty.slice(0, 5).map((l) => l.replace(/^\s*\S+\s+/, "")).join(", ")}${dirty.length > 5 ? " …" : ""}`,
          "Erst committen oder stashen.",
        )
      : result("git-clean", "Arbeitsverzeichnis sauber", "ok", "Keine uncommitteten Änderungen."),
  );

  const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout;
  checks.push(
    branch === "main"
      ? result("git-branch", "Branch", "ok", "main")
      : result("git-branch", "Branch", "warn", `Ausgecheckt ist "${branch}", Coolify deployt "main".`, "Auf main wechseln, außer du willst bewusst einen anderen Branch testen."),
  );

  const fetch = await git("fetch", "--quiet", "origin");
  const upstream = await git("rev-parse", "--verify", "--quiet", "@{u}");
  if (!upstream.ok) {
    checks.push(result("git-sync", "Mit origin synchron", "error", `Branch ${branch} hat keinen Upstream.`, `git push -u origin ${branch}`));
  } else {
    const ahead = Number((await git("rev-list", "--count", "@{u}..HEAD")).stdout);
    const behind = Number((await git("rev-list", "--count", "HEAD..@{u}")).stdout);
    if (behind > 0) {
      checks.push(result("git-sync", "Mit origin synchron", "error", `${behind} Commit(s) hinter origin.`, "Erst git pull."));
    } else if (ahead > 0) {
      checks.push(result("git-sync", "Mit origin synchron", "warn", `${ahead} Commit(s) noch nicht gepusht.`, "deploy:fast pusht automatisch."));
    } else {
      checks.push(result("git-sync", "Mit origin synchron", fetch.ok ? "ok" : "warn", fetch.ok ? "Aktuell." : "git fetch fehlgeschlagen, Stand evtl. veraltet."));
    }
  }
  const head = (await git("log", "-1", "--format=%h %s")).stdout;
  return { checks, branch, head };
}

function flattenKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? flattenKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function checkLocales() {
  const dir = join(REPO_ROOT, LOCALES_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const keys = {};
  for (const file of files) {
    try {
      keys[file.replace(/\.json$/, "")] = new Set(flattenKeys(JSON.parse(readFileSync(join(dir, file), "utf8"))));
    } catch (err) {
      return result("locales", "Übersetzungen", "error", `${LOCALES_DIR}/${file}: ${err.message}`, "JSON reparieren, sonst bricht der Build.");
    }
  }
  const base = keys[BASE_LOCALE];
  const problems = [];
  for (const [locale, set] of Object.entries(keys)) {
    if (locale === BASE_LOCALE || !base) continue;
    const missing = [...base].filter((k) => !set.has(k));
    const extra = [...set].filter((k) => !base.has(k));
    if (missing.length) problems.push(`${locale}: ${missing.length} fehlen (z. B. ${missing[0]})`);
    if (extra.length) problems.push(`${locale}: ${extra.length} nur dort (z. B. ${extra[0]})`);
  }
  return problems.length
    ? result("locales", "Übersetzungen", "warn", problems.join("; "), "Fehlende Schlüssel nachziehen.")
    : result("locales", "Übersetzungen", "ok", `${files.length} Sprachen gültig und vollständig.`);
}

async function checkPrisma() {
  const res = await exec("pnpm", ["exec", "prisma", "validate"], { timeout: 60_000 });
  return res.ok
    ? result("prisma", "Prisma-Schema", "ok", "Gültig.")
    : result("prisma", "Prisma-Schema", "error", res.stderr.split("\n").slice(-5).join(" "), "pnpm db:validate");
}

async function checkLocalDocker() {
  const res = await exec("docker", ["--context", BUILD_CONTEXT, "info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 });
  return res.ok
    ? result("docker-local", "Lokaler Docker", "ok", `${BUILD_CONTEXT} läuft (Docker ${res.stdout}).`)
    : result("docker-local", "Lokaler Docker", "warn", "Docker Desktop läuft nicht.", "deploy:fast startet ihn automatisch (dauert etwas).");
}

async function checkServer() {
  const ps = await exec(
    "docker",
    ["--context", SERVER_CONTEXT, "ps", "--filter", "label=coolify.type=application", "--filter", `name=${SERVICE}-`, "--format", "{{.Image}}\t{{.Status}}"],
    { timeout: 25_000 },
  );
  if (!ps.ok) {
    return {
      checks: [result("server", "Server erreichbar", "error", `${SERVER_CONTEXT}: ${ps.stderr.split("\n")[0]}`, "SSH-Verbindung / VPN prüfen.")],
    };
  }
  const [image, ...statusParts] = (ps.stdout.split("\n")[0] ?? "").split("\t");
  if (!image) {
    return { checks: [result("server", "Server erreichbar", "error", `Kein laufender Container "${SERVICE}".`, "Einmal normal über Coolify deployen.")] };
  }
  const checks = [result("server", "Server erreichbar", "ok", `${SERVER_CONTEXT}, Container ${statusParts.join(" ")}`)];
  const liveSha = image.split(":").pop() ?? "";
  const known = /^[0-9a-f]{7,40}$/.test(liveSha) && (await git("cat-file", "-e", `${liveSha}^{commit}`)).ok;
  if (!known) {
    checks.push(result("live", "Live-Version", "warn", `Unbekannter Stand (${liveSha.slice(0, 12)}).`, "Migrationen lassen sich nicht vergleichen, im Zweifel mit Migrationen deployen."));
    return { checks, liveSha, migrationsPending: null };
  }
  const newCommits = Number((await git("rev-list", "--count", `${liveSha}..HEAD`)).stdout);
  const liveSubject = (await git("log", "-1", "--format=%s", liveSha)).stdout;
  checks.push(
    newCommits === 0
      ? result("live", "Live-Version", "warn", `${liveSha.slice(0, 7)} läuft bereits (${liveSubject}).`, "Nichts Neues zu deployen.")
      : result("live", "Live-Version", "ok", `${liveSha.slice(0, 7)} „${liveSubject}“, ${newCommits} neue(r) Commit(s).`),
  );
  const migrations = (await git("diff", "--name-only", "--diff-filter=A", liveSha, "HEAD", "--", "prisma/migrations"))
    .stdout.split("\n")
    .filter((f) => f.endsWith("migration.sql"))
    .map((f) => f.split("/").at(-2));
  checks.push(
    migrations.length
      ? result("migrations", "Datenbank-Migrationen", "warn", `Neu seit Live: ${migrations.join(", ")}`, "Mit „Deploy + Migrationen“ starten.")
      : result("migrations", "Datenbank-Migrationen", "ok", "Keine neuen Migrationen."),
  );
  return { checks, liveSha, migrationsPending: migrations.length > 0, newCommits };
}

const [gitRes, prisma, docker, server] = await Promise.all([
  checkGit(),
  checkPrisma(),
  checkLocalDocker(),
  offline ? Promise.resolve({ checks: [result("server", "Server erreichbar", "skip", "Übersprungen (--offline).")] }) : checkServer(),
]);
const checks = [...gitRes.checks, checkLocales(), prisma, docker, ...server.checks];
const report = {
  ok: checks.every((c) => c.status !== "error"),
  branch: gitRes.branch,
  head: gitRes.head,
  liveSha: server.liveSha ?? null,
  newCommits: server.newCommits ?? null,
  migrationsPending: server.migrationsPending ?? null,
  serverContext: SERVER_CONTEXT,
  summary: `${gitRes.branch} @ ${gitRes.head}${server.liveSha ? `  ·  live ${server.liveSha.slice(0, 7)}${server.newCommits != null ? ` (+${server.newCommits})` : ""}` : ""}`,
  // Für das Deploy Panel (hanthascripts/deploy-panel): hebt diesen Button hervor.
  recommend: server.migrationsPending ? "migrate" : null,
  recommendReason: server.migrationsPending ? "Seit der Live-Version gibt es neue Datenbank-Migrationen." : null,
  checks,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const icon = { ok: "\x1b[32m✔\x1b[0m", warn: "\x1b[33m!\x1b[0m", error: "\x1b[31m✖\x1b[0m", skip: "\x1b[2m–\x1b[0m" };
  console.log(`\n\x1b[1mDeploy-Check\x1b[0m  ${report.branch} @ ${report.head}\n`);
  for (const c of checks) {
    console.log(`  ${icon[c.status]} ${c.label.padEnd(24)} ${c.detail}`);
    if (c.hint && c.status !== "ok") console.log(`    \x1b[2m→ ${c.hint}\x1b[0m`);
  }
  console.log(report.ok ? "\n\x1b[32mBereit für pnpm deploy:fast" + (report.migrationsPending ? " --migrate" : "") + "\x1b[0m\n" : "\n\x1b[31mBitte erst die Fehler beheben.\x1b[0m\n");
}
process.exit(report.ok ? 0 : 1);
