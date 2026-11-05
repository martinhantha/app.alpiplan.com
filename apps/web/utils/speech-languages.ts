/** Languages offered for speech recognition per tenant (BCP-47). */
export const SPEECH_LANGUAGES = ["de-DE", "de-AT", "de-CH", "it-IT", "en-GB"] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];
export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguage = "de-DE";

export function isSpeechLanguage(value: unknown): value is SpeechLanguage {
  return typeof value === "string" && (SPEECH_LANGUAGES as readonly string[]).includes(value);
}
