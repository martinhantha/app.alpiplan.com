# Organisator-Assistent — Spezifikation

Begleitend zum Konzept (Abschnitt 8a): Umsetzungsdetails für Produkt/Frontend/Backend.

## 1. Gegenfragen (Clarifying Questions)

### Auslöser

- Parser-Konfidenz unter Schwelle (pro Feld konfigurierbar, z. B. `< 0.6`).
- Mehrdeutige Entität (mehrere Lehrer mit gleichem Vornamen).
- Fehlende Pflichtplanungsinformation (z. B. Dauer unklar, aber für Konfliktprüfung nötig).
- Planungskonflikt nach serverseitiger Validierung.

### Darstellung

- Max. **3** aktive Fragen pro Flow; Rest in „Details“ ausklappbar.
- Antworten als **`UButton` / Chips**, keine Freitext-Pflicht.
- **`Später klären`**: nur wenn Speichern als `draft` fachlich erlaubt ist.

### API

- `POST /assistant/parse-intent` liefert `clarifyingQuestions[]` mit stabilen `id` und `options[]`.
- Client sendet Antworten als PATCH auf denselben Intent-Entwurf oder kumulativ im nächsten Parse-Request (`answers: { [questionId]: value }` — Endpoint im Backend verfeinern).

## 2. „Merken“ — Präferenzen

### Explizit (`UserAssistantPreference`)

- Nach Nutzerentscheidung: Toggle **„Für künftige Termine merken“**.
- Keys namespaced: z. B. `defaults.durationMinutes`, `defaults.lessonTypeId`, `defaults.resourceId`.
- `source = explicit_user`.

### Aus Korrekturen lernen

- Standard: **aus** oder `suggestions_only`.
- Bei Korrektur: Ereignis `learn_signal` (ohne Audio/PII) — z. B. Alias→`customerId`.
- `source = learned_correction`; in **Einstellungen → Assistenz** einzeln löschbar.

## 3. Automatisierung

- **MVP:** `AppointmentTemplate` / Kurzbefehle — keine Hintergrund-Engine.
- **Phase 2:** `AutomationRule` mit allowlist für `trigger`/`actions`; Ausführung in `AutomationRun` + `AuditLog`.

## 4. DSGVO

- Siehe [LEGAL_PRIVACY.md](./LEGAL_PRIVACY.md): Transparenz, Export, Löschung, kein Cross-Tenant-Learning.

## 5. Akzeptanzkriterien (Auszug)

- Bei hoher Konfidenz **keine** unnötigen Rückfragen (Happy Path &lt; 5 s).
- Keine automatische Buchung ohne Nutzerbestätigung (MVP).
- Alle Assistenz-Daten für Nutzer **einsehbar und löschbar**.

## 6. KI-Textauswertung (optional pro Mandant)

Stand 2026-10-30. `POST /assistant/parse-intent` hat zwei Wege:

1. **Regel-Parser** (`server/utils/parse-intent.ts`): immer verfügbar, auch offline/ohne Key. Seit 2026-10 mit unscharfem Namensabgleich (Levenshtein + Kölner Phonetik, `server/utils/fuzzy-name.ts`); exakte Treffer haben Vorrang.
2. **KI-Extraktion** (`server/utils/ai-intent.ts`): aktiv, wenn `Tenant.aiParsingEnabled` gesetzt ist **und** ein Anbieter konfiguriert ist. Anbieter: Anthropic (`ANTHROPIC_API_KEY`, Standardmodell `claude-haiku-5-5`) oder Google Gemini (`GEMINI_API_KEY`, Standardmodell `gemini-flash-lite-latest`, ein von Google gepflegter Alias; `gemini-flash-latest` war beim Test am 2026-10-30 mit 34 s Antwortzeit bzw. Überlastung für die Schnellerfassung zu langsam), Auswahl über `ASSISTANT_AI_PROVIDER` oder automatisch nach vorhandenem Key. Das Modell strukturiert den Text nur; IDs löst `resolveExtractedIntent` serverseitig gegen den Katalog auf. Bei Fehler oder Timeout antwortet der Regel-Parser. Die Antwort enthält `source: "ai" | "rules"`.

Datensparsamkeit: An das Modell gehen Text, Datum/Zeitzone, Lehrer-Bezeichnung, Namen der Lehrer, Terminarten und Ressourcen sowie die Mandanten-Hinweise (`Tenant.assistantHints`). **Kundenlisten und Telefonnummern aus dem Katalog werden nicht übermittelt.** Jede Anfrage wird ohne Text in `AssistantUsage` protokolliert (`model` = `anbieter/modell`, Token, Latenz, Erfolg) zur Kostenzuordnung je Mandant.

Freischaltung: `Tenant.speechRecognitionEnabled` und `Tenant.aiParsingEnabled` setzt nur der Superadmin (Mandanten-Seite oder Einstellungen im jeweiligen Mandanten); Mandanten-Admins sehen die Schalter nur lesend. Sprache und Hinweise bleiben beim Mandanten-Admin.

Spracherkennung: Sprache pro Mandant (`Tenant.speechLanguage`), Android 13+ erhält Katalognamen als Biasing-Strings, bei mehreren Alternativen gewinnt die mit den meisten bekannten Namen (`utils/speech-transcript.ts` → `pickTranscript`).
