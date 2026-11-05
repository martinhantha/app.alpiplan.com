<script setup lang="ts">
definePageMeta({
  public: true,
  layout: false,
});

const config = useRuntimeConfig().public;
const { login } = useAuth();
const { t } = useI18n();

const email = ref("");
const password = ref("");
const pending = ref(false);
const errorMsg = ref("");

const route = useRoute();

async function onSubmit() {
  errorMsg.value = "";
  pending.value = true;
  try {
    await login(email.value.trim(), password.value);
    const raw = route.query.redirect;
    const redirect = typeof raw === "string" ? raw : null;
    const safe =
      redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
    await navigateTo(safe);
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; statusMessage?: string };
    errorMsg.value = err?.data?.message || err?.statusMessage || t("login.failed");
  } finally {
    pending.value = false;
  }
}

const privacyUrl = usePrivacyUrl();
</script>

<template>
  <div
    class="night-hero min-h-dvh flex flex-col items-center justify-center px-6 pt-[max(2rem,var(--app-safe-top))] pb-[max(12rem,var(--app-safe-bottom))] sm:pb-64"
  >
    <AlpineRidge class="absolute inset-x-0 bottom-0 -z-10 h-48 w-full sm:h-72" />

    <div class="w-full max-w-md space-y-8 animate-fade-in">
      <div class="text-center space-y-5">
        <AppLogo size="lg" inverted />
        <div class="space-y-3">
          <h1 class="font-display text-4xl leading-[1.05] sm:text-5xl">{{ $t("login.title") }}</h1>
          <p class="text-base text-white/70 max-w-sm mx-auto leading-relaxed">
            {{ $t("login.subtitle") }}
          </p>
        </div>
      </div>

      <UCard class="rounded-[1.75rem] shadow-(--shadow-lift) ring-0 text-neutral-900 dark:text-neutral-50">
        <template #header>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            {{ $t("login.cardHint") }}
          </p>
        </template>

        <UAlert
          v-if="errorMsg"
          color="error"
          variant="soft"
          :title="errorMsg"
          class="mb-4"
          icon="i-lucide-circle-alert"
        />

        <form class="space-y-4" @submit.prevent="onSubmit">
          <UFormField :label="$t('login.email')" name="email">
            <UInput
              v-model="email"
              type="email"
              autocomplete="username"
              size="lg"
              class="w-full"
              :placeholder="$t('login.emailPlaceholder')"
            />
          </UFormField>
          <UFormField :label="$t('login.password')" name="password">
            <UInput
              v-model="password"
              type="password"
              autocomplete="current-password"
              size="lg"
              class="w-full"
            />
            <template #hint>
              <NuxtLink
                :to="{ path: '/forgot-password', query: email ? { email: email.trim() } : undefined }"
                class="text-xs underline underline-offset-2 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
              >
                {{ $t("login.forgot") }}
              </NuxtLink>
            </template>
          </UFormField>
          <UButton type="submit" block size="lg" :loading="pending" :disabled="pending">
            {{ $t("login.submit") }}
          </UButton>
        </form>

        <template #footer>
          <p class="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed text-center space-x-3">
            <NuxtLink to="/support" class="underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200">
              Support
            </NuxtLink>
            <span aria-hidden="true">·</span>
            <a :href="privacyUrl" target="_blank" rel="noopener" class="underline underline-offset-2 hover:text-neutral-700 dark:hover:text-neutral-200">
              {{ t("supportPage.footerPrivacy") }}
            </a>
          </p>
        </template>
      </UCard>
    </div>
  </div>
</template>
