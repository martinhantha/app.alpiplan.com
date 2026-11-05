# Coolify-Deployment (Alpiplan / ogama)

Coolify orchestriert Docker-Compose-Stacks. Dieses Repository liefert [`docker-compose.yml`](../docker-compose.yml) als Referenz für **lokale Entwicklung** und als Vorlage für **Staging/Production**.

## Services

| Service | Zweck |
|---------|--------|
| `postgres` | Primärdatenbank (Prisma / PostgreSQL 16) |
| `redis` | Sessions, Rate-Limits, Queues (MVP minimal) |
| `web` | Nuxt 4 + Nitro (SSR, `/api/v1/*`, Cookie-Session `/api/auth/*`) — siehe `apps/web` |
| `worker` | Optional: Hintergrundjobs (`docker compose --profile worker up`) |
| `backup` | Optional: täglicher `pg_dump` via Profil `backup` |

## Coolify: empfohlene Schritte

1. **Neues Projekt** in Coolify anlegen (z. B. `alpiplan-production`).
2. **PostgreSQL** und **Redis** entweder als verwaltete Coolify-Services **oder** wie hier als Compose-Services betreiben.
3. **Secrets** in Coolify setzen (nicht im Git):
   - `POSTGRES_PASSWORD` (stark)
   - `DATABASE_URL` für die **Web-/Nitro-App** (zeigt auf den Postgres-Service)
   - `REDIS_URL`
   - JWT / OIDC Secrets für Auth
   - Push (FCM): `FIREBASE_SERVICE_ACCOUNT` = kompletter Inhalt der Dienstkonto-JSON (eine Zeile / Multiline-Secret). Nicht die `google-services.json`.
   - **`DATABASE_URL` muss gesetzt sein**: Beim Start des **web**-Containers führt [`apps/web/docker-entrypoint.sh`](../apps/web/docker-entrypoint.sh) automatisch `prisma migrate deploy` aus (Stand in Postgres-Tabelle `_prisma_migrations`). Abschalten: `RUN_DB_MIGRATIONS=0`. Die 15-Minuten-Erinnerung und das Vortags-Briefing (Standard 20:00, pro Benutzer einstellbar) sendet der **web**-Prozess, kein extra Worker.
4. **Persistent Volumes** für Postgres-Daten und optional `pg_backups` mounten.
5. **Reverse Proxy / TLS**: Coolify vergibt automatisch Zertifikate; öffentliche Domain für die **Web-/API-App** ist **`app.alpiplan.com`** (`web`, Port 3000 im Compose-Beispiel).
6. **Worker & Backup**: In Coolify als zusätzliche Services deployen oder dieselben Compose-Profile nutzen, sofern unterstützt.

## Web-Image (Nuxt + Nitro-API)

- Build: Repository-Root, Dockerfile `apps/web/Dockerfile` (siehe [docker-compose.yml](../docker-compose.yml))
- Port im Container: **3000** (an Proxy weiterreichen)
- Healthcheck: `GET /api/health`
- DB-Migrationen: automatisch beim Container-Start (siehe Entrypoint oben); lokal manuell: `pnpm db:deploy`

### Release auf main (`pnpm deploy:main`)

Alltagsarbeit liegt auf **`develop`**. Coolify deployt **`main`**.

`pnpm deploy:main` erhöht `nativeAppVersion` in [`apps/mobile-shell/capacitor.config.ts`](../apps/mobile-shell/capacitor.config.ts) (`versionCode` + 1, `versionName` als Patch), committet das auf `develop`, setzt das Tag `vX.Y.Z` und fast-forwardet `main` auf denselben Commit. Danach landen `develop`, `main` und das Tag auf `origin`.

`pnpm deploy` ist ein eingebauter pnpm-Befehl und startet dieses Script nicht.

```bash
git checkout develop
pnpm deploy:main --dry-run    # nächste Version anzeigen
pnpm deploy:main              # Patch, z. B. 1.0.12 → 1.0.13
pnpm deploy:main --minor      # 1.0.12 → 1.1.0
pnpm deploy:main --version 2.0.0
```

`main` muss ein Vorfahre von `develop` sein. Liegen auf `main` Commits, die `develop` nicht hat, bricht das Script ab — zuerst `main` nach `develop` mergen.

Einmalig, falls `develop` noch fehlt:

```bash
git checkout -b develop
git push -u origin develop
```

In Coolify den Produktions-Branch auf `main` stellen. Startet Coolify den Build nicht von selbst, denselben Commit mit `pnpm deploy:local` ausliefern.

### Alles in einem Schritt (`pnpm deploy:fast`)

[`scripts/deploy-fast.mjs`](../scripts/deploy-fast.mjs) kapselt den lokalen Weg für Hotfixes: prüft den Git-Stand und pusht den Branch bei Bedarf, startet Docker Desktop, falls es nicht läuft, ruft `deploy-local` mit den vorbelegten Contexts auf (`DEPLOY_CONTEXT`, Standard `avelom.cloud`; `DEPLOY_BUILD_CONTEXT`, Standard `desktop-linux`) und zeigt danach die Push-, Assistant- und Fehlerzeilen des neuen Containers.

```bash
pnpm deploy:fast --dry-run   # nur bauen und prüfen
pnpm deploy:fast             # bauen, hochladen, neu starten, Logs zeigen
pnpm deploy:fast --migrate   # zusätzlich Migrationen vor dem Neustart
```

Es wird ausschließlich der Container der Anwendung `web-alpiplan` neu gestartet (`--no-deps`), andere Coolify-Anwendungen sowie Postgres und Redis bleiben unberührt.

### Lokal bauen statt am Server (`pnpm deploy:local`)

Für den Fall, dass der Server-Build zu schwer ist: [`scripts/deploy-local.mjs`](../scripts/deploy-local.mjs) baut das Web-Image lokal für die Server-Architektur, lädt es über den Docker-Context (SSH) auf den Server und startet den bestehenden Coolify-Container damit neu. In Coolify muss nichts umgestellt werden.

```bash
pnpm deploy:local --dry-run   # nur lokal bauen + Server prüfen
pnpm deploy:local             # bauen, hochladen, neu starten, /api/health prüfen
pnpm deploy:local --migrate   # optional: Migrationen vor dem Neustart (zusätzlich zum Entrypoint)
```

- Voraussetzungen: Docker Desktop läuft, SSH-Docker-Context zum Server (`docker context ls`), sauberer und gepushter Git-Stand.
- Das Script passt die von Coolify generierte `/data/coolify/applications/<uuid>/docker-compose.yaml` an (Backup: `*.before-local`). Coolify zeigt danach weiterhin den letzten eigenen Deploy an; der nächste normale Coolify-Deploy baut wieder am Server.
- Bei fehlgeschlagenem Health-Check wird angeboten, auf die vorherige Version zurückzusetzen. Alte Images bis auf die aktuelle und die vorherige Version werden entfernt.

## Capacitor (Mobile Shell)

- Web-Build läuft als SSR-Container oder statisch; Capacitor-Build ergänzt native Shells.
- Capacitor-Build: CI erzeugt `android/` / `ios/` Artefakte; Store-Upload außerhalb von Coolify oder über eigene Pipeline.

## Restore-Drill

- Quartalsweise Test-Restore aus `pg_backups` (oder externem Object Storage) durchführen und dokumentieren.
