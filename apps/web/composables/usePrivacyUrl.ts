const PRIVACY_PATHS: Record<string, string> = {
  de: "/datenschutz",
  en: "/en/privacy",
  it: "/it/privacy",
};

/** Die Datenschutzerklärung liegt auf der Webseite, pro Sprache unter eigener URL. */
export function usePrivacyUrl() {
  const { locale } = useI18n();
  const { websiteUrl } = useRuntimeConfig().public;
  return computed(() => `${websiteUrl}${PRIVACY_PATHS[locale.value] ?? PRIVACY_PATHS.de}`);
}
