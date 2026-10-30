# Rechtliches & Datenschutz — Pflichtenheft-Anhang (Alpiplan / ogama)

> **Hinweis:** Keine Rechtsberatung. Vor Produktivgang von Fachanwält:innen / DSB prüfen lassen.

## 1. Rollen nach DSGVO

| Akteur | Typische Einordnung |
|--------|---------------------|
| **Alpiplan-Betreiber** (Software-Anbieter) | Auftragsverarbeiter (AV) gegenüber den **Mandanten** (Flugschule etc.), sofern diese Personendaten in der App verarbeiten. |
| **Mandant (Unternehmen)** | Verantwortliche für die in ihrem Account verarbeiteten Daten (Lehrkräfte, Kund:innen, Schüler:innen). |
| **Endnutzer:innen (App)** | Betroffene; Rechte auf Auskunft, Löschung, Berichtigung, Datenportabilität (über den Mandanten bzw. exportierbare Funktionen). |

## 2. Auftragsverarbeitung (AV-Vertrag)

- Zwischen **Anbieter** und jedem **Mandanten** ist ein **AV-Vertrag** (Art. 28 DSGVO) erforderlich, bevor produktive Personendaten verarbeitet werden.
- Anlage: **TOM** (technisch-organisatorische Maßnahmen), Unterauftragsverzeichnis (Hosting, ggf. E-Mail/Push, optionale Cloud-Transkription).

## 3. Datenkategorien (Beispiel)

- Identifikation: Name, Kontakt (Telefon, E-Mail), Adresse
- Organisationsdaten: Termine, Verfügbarkeiten, Notizen, Zahlungsstatus
- Optionale Gerätedaten: Kontaktverknüpfungen, (Android) Telefonie-Hinweise — nur mit **expliziter Einwilligung** und **zweckgebundener** Verarbeitung
- Technische Daten: Geräte-IDs für Push, Logs (minimiert)

## 4. Optionale Android-Funktion: Call-Log / letzte Nummern

**Risiko:** hohe Sensibilität; Play-Store-Richtlinien, Nutzererwartung, Transparenzpflichten.

**Pflichtenheft-Anforderungen**

- Feature **standardmäßig aus**; Aktivierung nur nach **klarem Opt-in** und **kurzer Zweckbeschreibung** (UI: Einstellungen → Dieses Gerät). Opt-in liegt in `localStorage`, nicht auf dem Server.
- **Keine** serverseitige Speicherung von Roh-Call-Logs, sofern nicht zwingend und rechtlich freigegeben; bevorzugt **nur clientseitige** Verarbeitung zu Vorschlägen.
- Datenschutzerklärung und ggf. Einwilligung dokumentieren; Widerruf jederzeit.
- iOS: vergleichbare Funktion i. d. R. **nicht** verfügbar → Feature als **Android-only optional** kennzeichnen.

## 5. Kontakte / Adressbuch

- Schreiben/Lesen von Gerätekontakten nur nach **OS-Permission** und **Nutzeraktion** (z. B. „Kontakt speichern“).
- App muss **vollständig ohne** Adressbuch funktionieren.
- Kennzeichnung als Alpiplan-Kontakt / interne Kundennummer als **optionale** Notizfelder (plattformabhängig).

## 6. Spracheingabe / Transkription

| Modus | Anforderung |
|-------|-------------|
| **On-device** (OS APIs) | Bevorzugt; Datenfluss primär lokal; Hinweis in Datenschutzinfos. |
| **Cloud-Transkription** (falls eingeführt) | **Separater Opt-in** (Mandant und/oder Endnutzer je nach Architektur); AV-Vertrag mit Subprozessor; Zweckbindung; Aufbewahrung minimieren. |

Audio **nicht** dauerhaft speichern, sofern nicht ausdrücklich erforderlich und gerechtfertigt.

## 7. Assistenz: „Merken“ und Lernen aus Korrekturen

- **Explizite Präferenzen:** Rechtsgrundlage **Einwilligung** oder **Vertrag** (Nutzung der App im Auftrag des Mandanten) — mit Mandant abstimmen.
- **Lernen aus Korrekturen:** Standard **aus** oder „nur Vorschläge“; transparent unter Einstellungen; **löschbar**; **Export** im DSGVO-Export des Mandanten vorsehen.
- **Keine** mandantenübergreifenden Profile.

## 8. Speicherbegrenzung und Löschung

- Soft Delete im System ≠ endgültige Löschung. Für DSGVO-Löschung: **Hard-Delete** oder **Anonymisierung** nach dokumentierter Frist / nach Antrag.
- Mandanten-**Export** (ZIP) zur Erfüllung von Datenportabilität vorsehen (siehe Konzept).

## 9. Checkliste für Release

- [ ] AV-Vorlage final
- [ ] Datenschutzerklärung (Anbieter + ggf. Mandanten-Vorlage)
- [ ] Einwilligungsdialoge für optionale Features
- [ ] Unterauftragsverzeichnis gepflegt
- [ ] TOM-Dokumentation

## Ergänzung 2026-10-30: KI-Textauswertung

Wenn ein Mandant die KI-Textauswertung aktiviert, werden die Eingabetexte der Schnellerfassung (inkl. darin enthaltener Namen und Telefonnummern) sowie Lehrer-, Terminart- und Ressourcennamen an die Anthropic-API übertragen. Kundenlisten werden nicht übertragen. **Offen:** Anthropic als Unterauftragsverarbeiter in den AV-Vertrag und die Datenschutzerklärung aufnehmen, bevor die Funktion für Mandanten freigeschaltet wird. API-Daten werden laut Anthropic-Nutzungsbedingungen nicht zum Training verwendet.
