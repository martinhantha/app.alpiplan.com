<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { $fetch } from "ofetch";
import { useAuth } from "../composables/useAuth";
import { formatTeachersCaption } from "../utils/appointment-contact";
import { toQuickCaptureDuplicateSeed } from "../utils/appointment-duplicate";
import { quickCaptureModalUi } from "../utils/quick-capture-modal-ui";

interface AppointmentListItem {
  id: string;
  startsAt: string;
  endsAt: string;
  status: "draft" | "confirmed" | "completed" | "cancelled";
  version: number;
  appointmentContactText: string | null;
  appointmentPhoneRaw: string | null;
  appointmentPhoneE164: string | null;
  unstructuredNote: string | null;
  teacher: { id: string; displayName: string } | null;
  teachers?: { id: string; displayName: string }[] | null;
  resource: { id: string; name: string } | null;
  lessonType: { id: string; name: string } | null;
  customer: {
    id: string;
    displayName: string;
    phones?: { e164: string | null; raw: string | null; isPrimary: boolean }[];
  } | null;
}

const { user, primaryTenant, teacherLabel, resourcesEnabled, speechRecognitionEnabled, canManageTenant, canPlanAllAppointments, canAccessWorkspace } =
  useAuth();
const { t, intlLocale } = useAppLocale();
const { appointmentStatusLabel, appointmentStatusColor } = useAppointmentStatus();
function teachersCaption(appointment: AppointmentListItem) {
  return formatTeachersCaption(appointment, {
    teacherProfileId: primaryTenant.value?.teacherProfileId,
    canManageTenant: canPlanAllAppointments.value,
    teacherLabel: teacherLabel.value,
  });
}

interface SchedulingOptions {
  teachers: { id: string; displayName: string }[];
}

const appointments = ref<AppointmentListItem[]>([]);
const schedulingOptions = ref<SchedulingOptions | null>(null);
const filterTeacherId = ref("");
const appointmentsLoading = ref(false);
const appointmentsError = ref("");
const savingId = ref("");
const selectedDateKey = ref("");
const quickOpen = ref(false);
const quickInitialContact = ref("");
const quickStartVoice = ref(false);
const editingAppointment = ref<AppointmentListItem | null>(null);
const infoAppointment = ref<AppointmentListItem | null>(null);
const infoOpen = computed({
  get: () => Boolean(infoAppointment.value),
  set: (open: boolean) => {
    if (!open) infoAppointment.value = null;
  },
});
const quickDuplicateSeed = ref<(AppointmentListItem & { id: "" }) | null>(null);

const quickCaptureAppointment = computed(
  () => editingAppointment.value ?? quickDuplicateSeed.value,
);

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(intlLocale.value, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDayLabel(value: Date) {
  return new Intl.DateTimeFormat(intlLocale.value, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(value);
}

function toDateKey(value: Date) {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeyFromIso(value: string) {
  return toDateKey(new Date(value));
}

function appointmentTitle(appointment: AppointmentListItem) {
  return appointment.customer?.displayName || appointment.appointmentContactText || t("home.noContact");
}

const upcomingCount = computed(() => {
  const stripKeys = new Set(calendarDays.value.map((day) => day.key));
  return appointments.value.filter((appointment) => stripKeys.has(dateKeyFromIso(appointment.startsAt))).length;
});
const todayCount = computed(() => {
  const today = toDateKey(new Date());
  return appointments.value.filter((appointment) => dateKeyFromIso(appointment.startsAt) === today).length;
});
const calendarDays = computed(() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: CALENDAR_STRIP_DAYS }).map((_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    const key = toDateKey(date);
    return {
      key,
      label: formatDayLabel(date),
      count: appointments.value.filter((appointment) => dateKeyFromIso(appointment.startsAt) === key).length,
      isToday: index === 0,
    };
  });
});
const selectedDateAppointments = computed(() =>
  appointments.value
    .filter((appointment) => dateKeyFromIso(appointment.startsAt) === selectedDateKey.value)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
);

async function loadSchedulingOptions() {
  if (!primaryTenant.value?.tenantId || !canPlanAllAppointments.value) {
    schedulingOptions.value = null;
    filterTeacherId.value = "";
    return;
  }
  schedulingOptions.value = await $fetch<SchedulingOptions>(
    `/api/v1/tenants/${primaryTenant.value.tenantId}/scheduling/options`,
    { credentials: "include" },
  );
}

const CALENDAR_STRIP_DAYS = 14;
let loadedRange: { from: number; to: number } | null = null;

function dateFromKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Today's strip plus the day picked in the date input, if that lies outside the strip. */
function appointmentsRange() {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + CALENDAR_STRIP_DAYS);
  if (selectedDateKey.value) {
    const selected = dateFromKey(selectedDateKey.value);
    const selectedEnd = new Date(selected);
    selectedEnd.setDate(selectedEnd.getDate() + 1);
    if (selected < from) from.setTime(selected.getTime());
    if (selectedEnd > to) to.setTime(selectedEnd.getTime());
  }
  return { from, to };
}

async function loadAppointments() {
  if (!primaryTenant.value) {
    appointments.value = [];
    return;
  }
  appointmentsLoading.value = true;
  appointmentsError.value = "";
  const { from, to } = appointmentsRange();
  loadedRange = { from: from.getTime(), to: to.getTime() };
  try {
    const response = await $fetch<{ data: AppointmentListItem[] }>(
      `/api/v1/tenants/${primaryTenant.value.tenantId}/appointments`,
      {
        credentials: "include",
        query: {
          from: from.toISOString(),
          to: to.toISOString(),
          pageSize: 500,
          sort: "asc",
          teacherId: filterTeacherId.value || undefined,
        },
      },
    );
    appointments.value = response.data;
  } catch (e: unknown) {
    const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
    appointmentsError.value =
      err.data?.data?.message || err.data?.message || err.statusMessage || t("home.loadAppointmentsFailed");
  } finally {
    appointmentsLoading.value = false;
  }
}

onMounted(async () => {
  selectedDateKey.value = toDateKey(new Date());
  await loadSchedulingOptions();
  await loadAppointments();
});

useAppointmentListSync(loadAppointments);

watch(quickOpen, (open) => {
  if (!open) {
    editingAppointment.value = null;
    quickStartVoice.value = false;
  }
});

watch(
  () => primaryTenant.value?.tenantId,
  async () => {
    await loadSchedulingOptions();
    await loadAppointments();
  },
);

watch(filterTeacherId, () => {
  loadAppointments();
});

watch(selectedDateKey, (key) => {
  if (!key || !loadedRange) return;
  const day = dateFromKey(key).getTime();
  if (day < loadedRange.from || day >= loadedRange.to) loadAppointments();
});

function openAssistant() {
  editingAppointment.value = null;
  quickDuplicateSeed.value = null;
  quickInitialContact.value = "";
  quickStartVoice.value = speechRecognitionEnabled.value;
  quickOpen.value = true;
}

function openAppointmentInfo(appointment: AppointmentListItem) {
  infoAppointment.value = appointment;
}

function editFromInfo() {
  const appointment = infoAppointment.value;
  infoAppointment.value = null;
  if (appointment) openEditAppointment(appointment);
}

function openEditAppointment(appointment: AppointmentListItem) {
  editingAppointment.value = appointment;
  quickDuplicateSeed.value = null;
  quickInitialContact.value = "";
  quickStartVoice.value = false;
  quickOpen.value = true;
}

function openDuplicateAppointment(appointment: AppointmentListItem) {
  editingAppointment.value = null;
  quickDuplicateSeed.value = toQuickCaptureDuplicateSeed(appointment);
  quickInitialContact.value = "";
  quickStartVoice.value = false;
  quickOpen.value = true;
}

function closeQuickCapture() {
  quickOpen.value = false;
  editingAppointment.value = null;
  quickDuplicateSeed.value = null;
  quickStartVoice.value = false;
}

async function onAppointmentSaved() {
  closeQuickCapture();
  await loadAppointments();
}

async function markCompleted(appointment: AppointmentListItem) {
  if (!primaryTenant.value?.tenantId) return;
  savingId.value = appointment.id;
  appointmentsError.value = "";
  try {
    await $fetch(`/api/v1/tenants/${primaryTenant.value.tenantId}/appointments/${appointment.id}`, {
      method: "PATCH",
      credentials: "include",
      body: { status: "completed" },
      headers: { "If-Match": String(appointment.version) },
    });
    await loadAppointments();
  } catch (e: unknown) {
    const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
    appointmentsError.value =
      err.data?.data?.message || err.data?.message || err.statusMessage || t("home.markCompletedFailed");
  } finally {
    savingId.value = "";
  }
}

async function deleteAppointment(appointment: AppointmentListItem) {
  if (!primaryTenant.value?.tenantId) return;
  if (
    !confirm(
      t("home.deleteConfirm", {
        title: appointmentTitle(appointment),
      }),
    )
  ) {
    return;
  }
  savingId.value = appointment.id;
  appointmentsError.value = "";
  try {
    await $fetch(`/api/v1/tenants/${primaryTenant.value.tenantId}/appointments/${appointment.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await loadAppointments();
  } catch (e: unknown) {
    const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
    appointmentsError.value =
      err.data?.data?.message || err.data?.message || err.statusMessage || t("home.deleteFailed");
  } finally {
    savingId.value = "";
  }
}
</script>

<template>
  <UContainer class="py-6 sm:py-8 space-y-6">
    <section
      class="relative isolate overflow-hidden rounded-2xl border border-neutral-200 bg-gradient-to-br from-white to-primary-50/60 px-6 pb-20 pt-7 dark:border-neutral-800 dark:from-neutral-900 dark:to-primary-950/30 sm:px-8 sm:pb-24"
    >
      <AlpineRidge
        variant="subtle"
        class="pointer-events-none absolute inset-x-0 bottom-0 -z-10 aspect-[15/4] min-h-32 w-full text-primary-600 dark:text-primary-300"
      />

      <p v-if="primaryTenant" class="eyebrow flex items-center gap-2">
        <span class="size-1.5 rounded-full bg-glow-500" aria-hidden="true" />
        {{ primaryTenant.tenantName }}
      </p>
      <h1 class="font-display mt-3 text-3xl sm:text-4xl">{{ $t("home.title") }}</h1>
      <p class="mt-2 max-w-xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-400 sm:text-base">
        {{ $t("home.subtitle") }}
      </p>
      <p v-if="user" class="mt-1 text-sm text-neutral-500">
        {{ $t("home.signedInAs") }} <span class="font-medium text-neutral-800 dark:text-neutral-200">{{ user.name || user.email }}</span>
      </p>

      <div class="mt-6 grid max-w-md grid-cols-2 gap-3">
        <div class="rounded-xl bg-white/80 px-4 py-3 ring-1 ring-neutral-200 backdrop-blur dark:bg-neutral-950/50 dark:ring-neutral-800">
          <p class="text-xs font-medium text-neutral-500">{{ $t("home.statsUpcoming") }}</p>
          <p class="font-display mt-1 text-3xl tabular-nums">{{ upcomingCount }}</p>
        </div>
        <div class="rounded-xl bg-white/80 px-4 py-3 ring-1 ring-neutral-200 backdrop-blur dark:bg-neutral-950/50 dark:ring-neutral-800">
          <p class="text-xs font-medium text-neutral-500">{{ $t("home.statsToday") }}</p>
          <p class="font-display mt-1 text-3xl tabular-nums text-primary-600 dark:text-primary-300">{{ todayCount }}</p>
        </div>
      </div>
    </section>

    <div class="grid gap-3 sm:grid-cols-2">
      <UButton to="/appointments" block size="xl" variant="soft" color="primary" icon="i-lucide-calendar-days">
        {{ $t("nav.appointments") }}
      </UButton>
      <UButton to="/archive" block size="xl" variant="outline" color="neutral" icon="i-lucide-archive">
        {{ $t("nav.archive") }}
      </UButton>
      <UButton
        v-if="canAccessWorkspace"
        block
        size="xl"
        color="primary"
        icon="i-lucide-zap"
        @click="openAssistant"
      >
        {{ speechRecognitionEnabled ? $t("home.quickCaptureWithAssistant") : $t("home.quickCapture") }}
      </UButton>
      <UButton
        v-if="canManageTenant"
        to="/conflicts"
        block
        size="xl"
        variant="outline"
        icon="i-lucide-git-merge"
      >
        {{ $t("nav.conflicts") }}
      </UButton>
      <UButton size="xl" variant="ghost" color="neutral" icon="i-lucide-refresh-cw" :loading="appointmentsLoading" @click="loadAppointments">
        {{ $t("home.reloadAppointments") }}
      </UButton>
    </div>

    <UAlert
      v-if="appointmentsError"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :title="appointmentsError"
    />

    <section class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
      <UCard class="min-w-0">
        <template #header>
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-lg font-semibold">{{ $t("home.appointmentsOnDay") }}</h2>
            <span class="text-sm text-neutral-500">{{ selectedDateKey }}</span>
          </div>
        </template>

        <div v-if="!primaryTenant" class="text-sm text-neutral-600 dark:text-neutral-400">
          {{ $t("home.noTenantForAppointments") }}
        </div>
        <div v-else-if="!selectedDateAppointments.length && !appointmentsLoading" class="text-sm text-neutral-600 dark:text-neutral-400">
          {{ $t("home.noAppointmentsOnDay") }}
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="appointment in selectedDateAppointments"
            :key="appointment.id"
            class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4"
          >
            <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
              <button
                type="button"
                class="min-w-52 grow cursor-pointer rounded-md text-left"
                :aria-label="t('appointment.info.open')"
                @click="openAppointmentInfo(appointment)"
              >
                <div class="flex items-start gap-2">
                  <div class="min-w-0">
                    <p class="font-medium">{{ appointmentTitle(appointment) }}</p>
                    <p class="text-sm text-neutral-600 dark:text-neutral-400">
                      {{ formatDateTime(appointment.startsAt) }}–{{ formatDateTime(appointment.endsAt).split(', ').pop() }}
                    </p>
                  </div>
                  <UBadge
                    v-if="appointmentStatusLabel(appointment.status)"
                    :color="appointmentStatusColor(appointment.status)"
                    variant="subtle"
                    class="shrink-0"
                  >
                    {{ appointmentStatusLabel(appointment.status) }}
                  </UBadge>
                </div>
                <div class="mt-1.5 flex flex-wrap gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                  <span v-if="teachersCaption(appointment)">{{ teachersCaption(appointment) }}</span>
                  <span v-if="resourcesEnabled && appointment.resource">{{ $t("home.resource") }}: {{ appointment.resource.name }}</span>
                  <span v-if="appointment.lessonType">{{ $t("home.type") }}: {{ appointment.lessonType.name }}</span>
                </div>
              </button>
              <AppointmentQuickActions
                class="ml-auto shrink-0"
                :appointment="appointment"
                :loading="savingId === appointment.id"
                :show-edit="canAccessWorkspace"
                :show-duplicate="canAccessWorkspace"
                :show-complete="canAccessWorkspace"
                :show-delete="canAccessWorkspace"
                @edit="openEditAppointment(appointment)"
                @duplicate="openDuplicateAppointment(appointment)"
                @complete="markCompleted(appointment)"
                @delete="deleteAppointment(appointment)"
              />
            </div>
          </div>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center gap-1">
            <h2 class="text-lg font-semibold">{{ $t("home.calendar") }}</h2>
            <FieldInfoPopover :aria-label="$t('home.calendarHintAria')">
              {{ $t("home.calendarHint") }}
            </FieldInfoPopover>
          </div>
        </template>
        <div class="space-y-3">
          <select
            v-if="canPlanAllAppointments && schedulingOptions?.teachers?.length"
            v-model="filterTeacherId"
            class="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm"
          >
            <option value="">{{ $t("home.allTeachers", { teacher: teacherLabel }) }}</option>
            <option v-for="teacher in schedulingOptions.teachers" :key="teacher.id" :value="teacher.id">
              {{ teacher.displayName }}
            </option>
          </select>
          <UInput v-model="selectedDateKey" type="date" />
          <div class="grid grid-cols-2 gap-2">
            <UButton
              v-for="day in calendarDays"
              :key="day.key"
              size="sm"
              :color="day.key === selectedDateKey ? 'primary' : 'neutral'"
              :variant="day.key === selectedDateKey ? 'soft' : 'outline'"
              class="justify-between"
              @click="selectedDateKey = day.key"
            >
              <span class="whitespace-nowrap">{{ day.label }}</span>
              <UBadge :color="day.count ? 'primary' : 'neutral'" variant="subtle">{{ day.count }}</UBadge>
            </UButton>
          </div>
        </div>
      </UCard>
    </section>

    <AppointmentInfoModal
      v-model:open="infoOpen"
      :appointment="infoAppointment"
      :can-edit="canAccessWorkspace"
      @edit="editFromInfo"
    />

    <UModal v-model:open="quickOpen" :ui="quickCaptureModalUi">
      <template #header>
        <div class="flex items-center justify-between gap-3 w-full">
          <div class="min-w-0 flex items-center gap-1">
            <h2 class="font-medium truncate">
              {{
                editingAppointment
                  ? $t("home.editAppointment")
                  : quickDuplicateSeed
                    ? $t("home.duplicateAppointment")
                    : $t("home.newQuickCapture")
              }}
            </h2>
            <FieldInfoPopover :aria-label="$t('home.modalHintAria')">
              <template v-if="editingAppointment">{{ $t("home.editHint") }}</template>
              <template v-else-if="quickDuplicateSeed">{{ $t("home.duplicateHint") }}</template>
              <template v-else>
                {{
                  $t(speechRecognitionEnabled ? "home.captureHintVoice" : "home.captureHintText", {
                    teacher: teacherLabel,
                    resource: resourcesEnabled ? $t("home.resourceSuffix") : "",
                  })
                }}
              </template>
            </FieldInfoPopover>
          </div>
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" @click="closeQuickCapture" />
        </div>
      </template>
      <template #body>
        <QuickCaptureForm
          :key="
            editingAppointment?.id ??
            (quickDuplicateSeed
              ? `dup-${quickDuplicateSeed.startsAt}-${quickDuplicateSeed.endsAt}`
              : `${quickStartVoice ? 'voice' : 'type'}-${quickInitialContact || 'empty'}`)
          "
          :appointment="quickCaptureAppointment"
          :initial-contact-text="quickInitialContact"
          :start-with-voice="quickStartVoice"
          @saved="onAppointmentSaved"
          @cancel="closeQuickCapture"
        />
      </template>
    </UModal>
  </UContainer>
</template>
