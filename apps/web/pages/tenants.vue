<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { $fetch } from "ofetch";

interface MembershipInfo {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "STAFF" | "END_CUSTOMER";
}
interface SuperadminTenant {
  id: string;
  name: string;
  slug: string;
  useDefaultDuration: boolean;
  speechRecognitionEnabled?: boolean;
  aiParsingEnabled?: boolean;
  createdAt?: string;
}
interface SuperadminUser {
  id: string;
  email: string;
  memberships: MembershipInfo[];
}
interface SuperadminOverview {
  tenants: SuperadminTenant[];
  users: SuperadminUser[];
}

const { user } = useAuth();
const { t } = useAppLocale();
const isSuperadmin = computed(() => Boolean(user.value?.isSuperadmin));

const tenants = ref<SuperadminTenant[]>([]);
const memberCounts = ref<Record<string, number>>({});
const loading = ref(false);
const savingId = ref("");
const error = ref("");
const info = ref("");

const filterOpen = ref(false);
const filters = reactive({ q: "" });

const dialogOpen = ref(false);
const dialogMode = ref<"create" | "edit">("create");
const editingId = ref<string | null>(null);
const form = reactive({
  name: "",
  slug: "",
  useDefaultDuration: true,
  speechRecognitionEnabled: false,
  aiParsingEnabled: false,
});

const filtered = computed(() => {
  const q = filters.q.trim().toLowerCase();
  if (!q) return tenants.value;
  return tenants.value.filter(
    (tenant) => tenant.name.toLowerCase().includes(q) || tenant.slug.toLowerCase().includes(q),
  );
});

const activeFilterCount = computed(() => (filters.q ? 1 : 0));

function setInfo(message: string) {
  info.value = message;
  error.value = "";
}
function setError(message: string) {
  error.value = message;
  info.value = "";
}
function apiMessage(e: unknown, fallback: string) {
  const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
  return err.data?.data?.message || err.data?.message || err.statusMessage || fallback;
}

async function load() {
  if (!isSuperadmin.value) {
    tenants.value = [];
    return;
  }
  loading.value = true;
  try {
    const overview = await $fetch<SuperadminOverview>("/api/admin/overview", {
      credentials: "include",
    });
    tenants.value = overview.tenants;
    const counts: Record<string, number> = {};
    for (const u of overview.users) {
      for (const m of u.memberships) {
        counts[m.tenantId] = (counts[m.tenantId] ?? 0) + 1;
      }
    }
    memberCounts.value = counts;
  } catch (e: unknown) {
    setError(apiMessage(e, t("tenantsPage.loadFailed")));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  dialogMode.value = "create";
  editingId.value = null;
  form.name = "";
  form.slug = "";
  form.useDefaultDuration = true;
  form.speechRecognitionEnabled = false;
  form.aiParsingEnabled = false;
  dialogOpen.value = true;
}

function openEdit(item: SuperadminTenant) {
  dialogMode.value = "edit";
  editingId.value = item.id;
  form.name = item.name;
  form.slug = item.slug;
  form.useDefaultDuration = item.useDefaultDuration;
  form.speechRecognitionEnabled = item.speechRecognitionEnabled ?? false;
  form.aiParsingEnabled = item.aiParsingEnabled ?? false;
  dialogOpen.value = true;
}

async function submit() {
  if (!form.name.trim() || !form.slug.trim()) {
    setError(t("common.nameAndSlugRequired"));
    return;
  }
  loading.value = true;
  try {
    const body = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      useDefaultDuration: form.useDefaultDuration,
      speechRecognitionEnabled: form.speechRecognitionEnabled,
      aiParsingEnabled: form.aiParsingEnabled,
    };
    if (dialogMode.value === "create") {
      await $fetch("/api/admin/tenants", {
        method: "POST",
        credentials: "include",
        body,
      });
      setInfo(t("tenantsPage.created"));
    } else if (editingId.value) {
      await $fetch(`/api/admin/tenants/${editingId.value}`, {
        method: "PATCH",
        credentials: "include",
        body,
      });
      setInfo(t("tenantsPage.updated"));
    }
    dialogOpen.value = false;
    await load();
  } catch (e: unknown) {
    setError(apiMessage(e, t("common.saveFailed")));
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <UContainer class="py-8 space-y-5">
    <div v-if="!isSuperadmin" class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-sm text-neutral-600 dark:text-neutral-400">
      {{ t("tenantsPage.superadminOnly") }}
    </div>
    <template v-else>
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p class="text-sm text-muted font-medium">{{ t("tenantsPage.breadcrumb") }}</p>
          <h1 class="font-display text-3xl sm:text-4xl">
            {{ t("tenantsPage.title") }}
            <span class="ml-2 text-sm font-normal text-neutral-500">({{ filtered.length }})</span>
          </h1>
          <p class="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            <UBadge color="secondary" variant="soft">SUPERADMIN</UBadge>
            <span class="ml-2">{{ t("tenantsPage.allInSystem") }}</span>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UButton
            variant="outline"
            color="neutral"
            icon="i-lucide-filter"
            @click="filterOpen = !filterOpen"
          >
            {{ t("common.filter") }}
            <UBadge v-if="activeFilterCount" color="primary" variant="subtle" class="ml-1">
              {{ activeFilterCount }}
            </UBadge>
            <UIcon
              :name="filterOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              class="ml-1 size-4"
            />
          </UButton>
          <UButton icon="i-lucide-plus" color="primary" @click="openCreate">
            {{ t("tenantsPage.add") }}
          </UButton>
        </div>
      </div>

      <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-circle-alert" :title="error" />
      <UAlert v-if="info" color="success" variant="soft" icon="i-lucide-circle-check" :title="info" />

      <UCard v-if="filterOpen">
        <template #header>
          <div class="flex items-center justify-between gap-3">
            <h2 class="font-medium">{{ t("common.filter") }}</h2>
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" @click="filterOpen = false" />
          </div>
        </template>
        <div class="grid gap-3 md:grid-cols-3">
          <UInput v-model="filters.q" :placeholder="t('common.searchNameOrSlug')" />
        </div>
      </UCard>

      <div
        v-if="!filtered.length && !loading"
        class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-sm text-neutral-600 dark:text-neutral-400"
      >
        {{ t("tenantsPage.empty") }}
      </div>
      <div v-else class="space-y-3">
        <UCard v-for="item in filtered" :key="item.id">
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div class="min-w-0">
              <p class="font-medium truncate">{{ item.name }}</p>
              <p class="text-xs text-neutral-500 truncate">{{ item.slug }}</p>
              <div class="mt-2 flex flex-wrap gap-1">
                <UBadge color="primary" variant="subtle">
                  {{ t("common.membersCount", { count: memberCounts[item.id] ?? 0 }) }}
                </UBadge>
                <UBadge :color="item.useDefaultDuration ? 'success' : 'neutral'" variant="subtle">
                  {{ item.useDefaultDuration ? t("tenantsPage.durationOn") : t("tenantsPage.durationOff") }}
                </UBadge>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <UButton
                size="sm"
                variant="ghost"
                color="neutral"
                icon="i-lucide-pencil"
                :loading="savingId === item.id"
                @click="openEdit(item)"
              >
                {{ t("common.edit") }}
              </UButton>
            </div>
          </div>
        </UCard>
      </div>

      <UModal v-model:open="dialogOpen" :ui="{ content: 'max-w-lg' }">
        <template #header>
          <div class="flex items-center justify-between gap-3 w-full">
            <h2 class="font-medium">
              {{ dialogMode === "create" ? t("tenantsPage.add") : t("tenantsPage.edit") }}
            </h2>
            <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" @click="dialogOpen = false" />
          </div>
        </template>
        <template #body>
          <form class="space-y-3" @submit.prevent="submit">
            <UFormField :label="t('common.name')">
              <UInput v-model="form.name" :placeholder="t('tenantsPage.namePlaceholder')" />
            </UFormField>
            <UFormField :label="t('common.slug')" :hint="t('tenantsPage.slugHint')">
              <UInput v-model="form.slug" :placeholder="t('tenantsPage.slugPlaceholder')" />
            </UFormField>
            <label class="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300 mt-2">
              <input v-model="form.useDefaultDuration" type="checkbox" class="mt-1" />
              <span>
                <span class="font-medium">{{ t("tenantsPage.defaultDuration") }}</span>
                <span class="block text-xs text-neutral-500 mt-0.5">
                  {{ t("tenantsPage.defaultDurationHint") }}
                </span>
              </span>
            </label>
            <label class="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <input v-model="form.speechRecognitionEnabled" type="checkbox" class="mt-1" />
              <span>
                <span class="font-medium">{{ t("tenantsPage.speechRecognition") }}</span>
                <span class="block text-xs text-neutral-500 mt-0.5">
                  {{ t("tenantsPage.speechRecognitionHint") }}
                </span>
              </span>
            </label>
            <label class="flex items-start gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <input v-model="form.aiParsingEnabled" type="checkbox" class="mt-1" />
              <span>
                <span class="font-medium">{{ t("tenantsPage.aiParsing") }}</span>
                <span class="block text-xs text-neutral-500 mt-0.5">
                  {{ t("tenantsPage.aiParsingHint") }}
                </span>
              </span>
            </label>
          </form>
        </template>
        <template #footer>
          <div class="flex justify-end gap-2 w-full">
            <UButton variant="ghost" color="neutral" @click="dialogOpen = false">{{ t("common.cancel") }}</UButton>
            <UButton
              color="primary"
              :loading="loading"
              :icon="dialogMode === 'create' ? 'i-lucide-plus' : 'i-lucide-save'"
              @click="submit"
            >
              {{ dialogMode === "create" ? t("common.add") : t("common.save") }}
            </UButton>
          </div>
        </template>
      </UModal>
    </template>
  </UContainer>
</template>
