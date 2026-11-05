<script setup lang="ts">
definePageMeta({
  public: true,
  layout: false,
});

const config = useRuntimeConfig().public;
const { t } = useI18n();

const providerName = config.legalName || "Alpiplan";
const supportEmail = config.supportEmail || "support@alpiplan.com";
const privacyUrl = usePrivacyUrl();

useSeoMeta({
  title: () => t("supportPage.seoTitle"),
  description: () => t("supportPage.seoDescription"),
  robots: "index, follow",
});
</script>

<template>
  <div
    class="min-h-dvh bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 pt-[max(1.5rem,var(--app-safe-top))] pb-[max(2rem,var(--app-safe-bottom))]"
  >
    <div class="mx-auto max-w-3xl px-6 py-8 space-y-10">
      <header class="space-y-4 border-b border-neutral-200 pb-8 dark:border-neutral-800">
        <NuxtLink
          to="/login"
          class="inline-flex items-center gap-1.5 text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          {{ t("supportPage.back") }}
        </NuxtLink>
        <div class="flex items-center gap-3">
          <AppLogo size="sm" />
          <span class="text-sm font-medium text-neutral-500 dark:text-neutral-400">Alpiplan</span>
        </div>
        <h1 class="font-display text-3xl sm:text-4xl leading-tight">Support</h1>
        <p class="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
          {{ t("supportPage.intro", { provider: providerName }) }}
        </p>
      </header>

      <article class="legal-prose space-y-8">
        <section>
          <h2>{{ t("supportPage.contact") }}</h2>
          <p>{{ t("supportPage.contactLead") }}</p>
          <p>
            <a :href="`mailto:${supportEmail}`">{{ supportEmail }}</a>
          </p>
          <p>{{ t("supportPage.contactDetails") }}</p>
        </section>

        <section>
          <h2>{{ t("supportPage.access") }}</h2>
          <p>{{ t("supportPage.accessLead") }}</p>
          <ul>
            <li>{{ t("supportPage.accessPassword") }}</li>
            <li>{{ t("supportPage.accessTenant") }}</li>
            <li>{{ t("supportPage.accessOrg", { email: supportEmail }) }}</li>
          </ul>
        </section>

        <section>
          <h2>{{ t("supportPage.push") }}</h2>
          <ul>
            <li>{{ t("supportPage.pushSettings") }}</li>
            <li>{{ t("supportPage.pushIos") }}</li>
            <li>{{ t("supportPage.pushWeb") }}</li>
          </ul>
          <p>{{ t("supportPage.pushMissing") }}</p>
        </section>

        <section>
          <h2>{{ t("supportPage.privacy") }}</h2>
          <p>
            {{ t("supportPage.privacyLead") }}
            <a :href="privacyUrl" target="_blank" rel="noopener">{{ t("supportPage.privacyLink") }}</a>.
            {{ t("supportPage.privacyRest") }}
          </p>
        </section>
      </article>

      <footer
        class="border-t border-neutral-200 pt-6 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400 flex flex-wrap gap-x-4 gap-y-1"
      >
        <a :href="privacyUrl" target="_blank" rel="noopener" class="underline underline-offset-2">{{ t("supportPage.footerPrivacy") }}</a>
        <NuxtLink to="/login" class="underline underline-offset-2">{{ t("supportPage.footerLogin") }}</NuxtLink>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.legal-prose :deep(h2) {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
}

.legal-prose :deep(p),
.legal-prose :deep(li) {
  font-size: 0.9375rem;
  line-height: 1.65;
  color: var(--color-neutral-700);
}

.dark .legal-prose :deep(p),
.dark .legal-prose :deep(li) {
  color: var(--color-neutral-300);
}

.legal-prose :deep(ul) {
  list-style: disc;
  padding-left: 1.25rem;
  margin: 0.5rem 0 1rem;
}

.legal-prose :deep(a) {
  color: var(--color-primary-600);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.dark .legal-prose :deep(a) {
  color: var(--color-primary-400);
}
</style>
