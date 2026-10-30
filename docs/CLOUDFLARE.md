# Cloudflare als Proxy vor Coolify (Plan)

Status: **geplant, noch nicht umgesetzt.**

Ziel: `alpiplan.com`, `cms.alpiplan.com` und `app.alpiplan.com` laufen über Cloudflare (DNS + Proxy). Hosting bleibt unverändert auf dem Coolify-Server (Traefik → Docker-Container).

```
Browser / Mobile App ──► Cloudflare (DNS, TLS, WAF, CDN) ──► Server: Traefik (Coolify) ──► web / cms / web-alpiplan
```

Gewinn: DDoS-Schutz, WAF, CDN-Caching statischer Assets, Server-IP verborgen.

## E-Mail (Ist-Stand, Stand 2026-10-28)

Cloudflare proxied nur HTTP(S) – E-Mail läuft nie über den Proxy. Relevant ist nur, dass die DNS-Einträge beim Umzug 1:1 mitkommen.

| Eintrag | Wert | Zweck |
|---------|------|-------|
| `alpiplan.com` MX | `10 mailserver.myflights.cloud` | Empfang (eigener Mailserver, **gleiche IP wie Web: 138.201.94.185**) |
| `alpiplan.com` TXT | `v=spf1 mx -all` | SPF für Empfangs-/Eigenversand |
| `_dmarc.alpiplan.com` TXT | `v=DMARC1; p=none; rua=mailto:postmaster@alpiplan.com` | DMARC |
| `resend._domainkey.alpiplan.com` TXT | DKIM-Key von Resend | Versand App + Anfrageformular (`smtp.resend.com`) |
| `send.alpiplan.com` | → `send.forge.rmta.net` (MX `feedback.forge.rmta.net`, SPF Resend) | Resend Return-Path / Bounces |

Folgen:

- Alle obigen Einträge in Cloudflare auf **„DNS only“** (graue Wolke). Cloudflare erlaubt keinen Proxy auf MX-Ziele; `send.alpiplan.com` (CNAME zu Resend) darf ebenfalls nicht geproxied werden, sonst bricht die Resend-Verifizierung.
- Nach dem Umzug im **Resend-Dashboard** „Verify DNS“ prüfen.
- **Server-IP bleibt öffentlich bekannt**, weil der MX auf denselben Server zeigt. Der Cloudflare-Proxy schützt Web-Traffic trotzdem, „IP verbergen“ greift aber erst, wenn der Mailserver auf einen anderen Host/Anbieter umzieht.
- `mailserver.myflights.cloud` liegt in einer anderen Zone (nicht Cloudflare) – dort ändert sich nichts.

## Schritt 1 – Vorbereitung (ohne Auswirkung)

1. Aktuelle DNS-Zone beim jetzigen Provider komplett exportieren bzw. abschreiben (A/AAAA, CNAME, **MX, SPF, DKIM, DMARC**, TXT-Verifizierungen für Google/Apple/Firebase usw.).
2. Cloudflare-Account anlegen (Free-Plan reicht), Domain `alpiplan.com` hinzufügen.
3. Von Cloudflare importierte Einträge mit dem Export abgleichen, fehlende ergänzen.
4. Alle Einträge zunächst auf **„DNS only“ (graue Wolke)** lassen – so ändert der Nameserver-Wechsel nichts am Verhalten.
5. TTL beim alten Provider vorab auf niedrig (z. B. 300 s) setzen.

## Schritt 2 – Code-Anpassung Website (vor dem Proxy-Schalten deployen)

Betrifft Repo `alpiplan.com`.

1. [`web/server/utils/rate-limit.ts`](../../alpiplan.com/web/server/utils/rate-limit.ts): Client-IP bevorzugt aus dem Header `CF-Connecting-IP` lesen, Fallback wie bisher `getRequestIP(event, { xForwardedFor: true })`.
   - Grund: Hinter Cloudflare sieht Traefik nur Cloudflare-IPs; sonst teilen sich alle Besucher dasselbe Limit (5 / 10 Min.).
   - `CF-Connecting-IP` ist nur vertrauenswürdig, wenn der Server ausschließlich über Cloudflare erreichbar ist (→ Schritt 6).
2. README-Abschnitt „Rate-Limit pro IP“ entsprechend anpassen (statt „hinter Traefik“ → „hinter Cloudflare“).
3. Deployen, Anfrageformular kurz testen.

## Schritt 3 – Nameserver umstellen

1. Beim Domain-Registrar die Nameserver auf die beiden von Cloudflare zugewiesenen ändern.
2. Warten, bis Cloudflare die Zone als **aktiv** meldet.
3. Prüfen: Website, CMS-Admin, App, **E-Mail-Empfang und -Versand** (SMTP der App und des Anfrageformulars).

## Schritt 4 – SSL/TLS in Cloudflare einstellen

1. SSL/TLS-Modus: **Full (strict)** (nicht „Flexible“ – sonst Redirect-Schleifen mit Traefik).
2. „Always Use HTTPS“: an.
3. Minimum TLS Version: 1.2.
4. Origin-Zertifikat: Let's Encrypt aus Coolify weiterverwenden.
   - Falls die Verlängerung hinter dem Proxy scheitert: Cloudflare Origin Certificate erzeugen und in Coolify/Traefik hinterlegen, oder Traefik auf DNS-Challenge mit Cloudflare-API-Token umstellen.
5. HSTS erst aktivieren, wenn alles stabil läuft.

## Schritt 5 – Proxy einschalten (orange Wolke), Subdomain für Subdomain

Reihenfolge mit dem geringsten Risiko:

1. **`cms.alpiplan.com`** → Proxy an. Testen: Admin-Login, Medien-Upload, Bilder auf der Website.
2. **`alpiplan.com`** (+ `www`) → Proxy an. Testen: alle drei Sprachen, Anfrageformular (ALTCHA, Rate-Limit, E-Mail), `sitemap.xml`, `/uploads/*`.
3. **`app.alpiplan.com`** → Proxy an. Testen:
   - Login/Logout (HttpOnly-Cookie `alpiplan_at`)
   - Echtzeit-Updates per SSE (`/api/v1/tenants/:id/events`) – Ping alle 20 s liegt unter dem Cloudflare-Timeout von 100 s
   - Web-Push und Firebase-Push
   - **Android- und iOS-App** (Capacitor): Login, Termine, Widget, Update-Hinweis
   - Hinweis auf neuen Web-Deploy (`checkOutdatedBuildInterval`)
4. **Nicht proxien (graue Wolke):** MX-, Mail-Hostnamen, SPF/DKIM/DMARC-TXT sowie alles, was kein HTTP(S) ist (z. B. SSH-Hostname, Datenbank-Ports).

## Schritt 6 – Server absichern

1. Server-Firewall: Ports **80/443 nur für Cloudflare-IP-Bereiche** öffnen (<https://www.cloudflare.com/ips/>), SSH weiterhin nur für eigene IPs.
   - **Achtung Mailserver:** Mail-Ports (25, 465, 587, 993 …) **nicht** einschränken.
   - **Achtung Zertifikate:** `mailserver.myflights.cloud` und alle anderen Domains auf diesem Server, die *nicht* über Cloudflare laufen, holen Let's Encrypt evtl. per HTTP-Challenge über Port 80 – das scheitert, wenn Port 80 nur noch Cloudflare erlaubt. Vorher prüfen, welche Domains auf 138.201.94.185 zeigen; ggf. diese Regel weglassen oder jene Domains ebenfalls über Cloudflare/DNS-Challenge laufen lassen.
2. Optional: Traefik `forwardedHeaders.trustedIPs` auf die Cloudflare-Bereiche setzen, damit auch `X-Forwarded-For` stimmt (z. B. für Logs).
3. Prüfen, dass die Coolify-Oberfläche selbst nicht offen im Internet hängt (eigene Subdomain + Proxy + Zugriffsschutz, oder nur per VPN/SSH-Tunnel).

## Schritt 7 – Cloudflare-Einstellungen feinjustieren

1. **Caching:** Standard belassen (HTML/API werden nicht gecacht). **Keine** „Cache Everything“-Regel für `app.alpiplan.com`.
   - Optional Cache-Regel: `/_nuxt/*` und `/uploads/*` lange cachen (Dateien sind versioniert bzw. ändern sich selten).
2. **Bot Fight Mode: aus** – blockiert sonst Requests der Mobile App.
3. **WAF / Security-Level:** Standard; keine JS-Challenge auf `app.alpiplan.com/api/*` und `/api/auth/*`.
4. Optional: Rate-Limiting-Regel in Cloudflare für `/api/auth/login` und `/api/inquiry` als zusätzliche Schicht.
5. Speed-Optimierungen (Rocket Loader, Auto Minify): **aus** lassen – können Nuxt-Hydration stören.
6. Uploads: Free-Plan begrenzt Requests auf 100 MB – für Strapi-Medien bedenken.

## Schritt 8 – Abschluss

1. HSTS aktivieren (nach einigen Tagen stabilem Betrieb).
2. Diese Datei und [COOLIFY.md](COOLIFY.md) auf den Ist-Stand bringen (Status „umgesetzt“).
3. Notfall-Rollback dokumentieren: Wolke auf grau stellen → Traffic geht wieder direkt an den Server (Firewall-Regel aus Schritt 6 dann vorübergehend öffnen).
