<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { $fetch } from "ofetch";
import { CalendarDate, type DateValue } from "@internationalized/date";
import type { DropdownMenuItem } from "@nuxt/ui";
import { formatTeachersCaption } from "../utils/appointment-contact";
import { toQuickCaptureDuplicateSeed } from "../utils/appointment-duplicate";
import { quickCaptureModalUi } from "../utils/quick-capture-modal-ui";
import { avatarColor, avatarInitials } from "../utils/avatar";
import {
  TIMELINE_BLOCK_COLORS,
  type TimelineBlock,
  type TimelineBlockKind,
  type TimelineCreate,
  type TimelineMove,
} from "../components/AppointmentTimeline.vue";

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
  teacher: { id: string; displayName: string; color?: string | null } | null;
  teachers?: { id: string; displayName: string; color?: string | null }[] | null;
  resource: { id: string; name: string } | null;
  lessonType: { id: string; name: string; color?: string | null } | null;
  customer: {
    id: string;
    displayName: string;
    phones?: { e164: string | null; raw: string | null; isPrimary: boolean }[];
  } | null;
}

interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface SchedulingOptions {
  teachers: { id: string; displayName: string; color?: string | null }[];
  lessonTypes: { id: string; name: string }[];
}

interface UnavailabilityItem {
  teacherId: string;
  date: string;
  kind: TimelineBlockKind;
  allDay: boolean;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

const { primaryTenant, teacherLabel, resourcesEnabled, speechRecognitionEnabled, canManageTenant, canPlanAllAppointments, canAccessWorkspace } = useAuth();
const { appointmentStatusLabel, appointmentStatusColor } = useAppointmentStatus();
const { t, intlLocale } = useAppLocale();

const appointments = ref<AppointmentListItem[]>([]);
const pagination = ref<Pagination>({ page: 1, pageSize: 25, total: 0, totalPages: 1 });
const options = ref<SchedulingOptions | null>(null);
const loading = ref(false);
const error = ref("");
const savingId = ref("");
const filterOpen = ref(false);
const quickOpen = ref(false);
const quickStartVoice = ref(false);
const quickInitialContact = ref("");
const quickInitialStartsAt = ref("");
const quickInitialTeacherId = ref("");
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
type AppointmentsView = "list" | "calendar";
type CalendarMode = "day" | "timeline" | "week" | "team" | "month";

const VIEW_STORAGE_KEY = "alpiplan.appointments.view";
const CALENDAR_MODE_STORAGE_KEY = "alpiplan.appointments.calendarMode";
const TIMELINE_STORAGE_KEY = "alpiplan.appointments.timeline.v2";
/** Before v2 "align to appointments" defaulted to on; only its hour range is carried over. */
const LEGACY_TIMELINE_STORAGE_KEY = "alpiplan.appointments.timeline";
const CALENDAR_MODES: CalendarMode[] = ["day", "timeline", "week", "team", "month"];

const view = ref<AppointmentsView>("list");
const calendarMode = ref<CalendarMode>("week");
const dayAnchor = ref<Date>(startOfDay(new Date()));
const weekStart = ref<Date>(getMondayOf(new Date()));
const monthAnchor = ref<Date>(firstOfMonth(new Date()));
const timeline = reactive({ auto: false, fromHour: 9, toHour: 17 });

function restoreViewPreference() {
  if (typeof localStorage === "undefined") return;
  const storedView = localStorage.getItem(VIEW_STORAGE_KEY);
  if (storedView === "list" || storedView === "calendar") view.value = storedView;
  const storedMode = localStorage.getItem(CALENDAR_MODE_STORAGE_KEY) as CalendarMode | null;
  if (storedMode && CALENDAR_MODES.includes(storedMode)) calendarMode.value = storedMode;
  try {
    const current = localStorage.getItem(TIMELINE_STORAGE_KEY);
    const storedTimeline = JSON.parse(current || localStorage.getItem(LEGACY_TIMELINE_STORAGE_KEY) || "null");
    if (storedTimeline && typeof storedTimeline === "object") {
      const { auto, fromHour, toHour } = storedTimeline;
      if (current && typeof auto === "boolean") timeline.auto = auto;
      if (Number.isInteger(fromHour) && Number.isInteger(toHour) && fromHour >= 0 && toHour <= 24 && fromHour < toHour) {
        timeline.fromHour = fromHour;
        timeline.toHour = toHour;
      }
    }
  } catch {
    // ignore corrupt preference
  }
}

function persistViewPreference() {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(VIEW_STORAGE_KEY, view.value);
  localStorage.setItem(CALENDAR_MODE_STORAGE_KEY, calendarMode.value);
}

watch(timeline, () => {
  if (timeline.fromHour >= timeline.toHour) {
    if (timeline.toHour >= 24) timeline.fromHour = timeline.toHour - 1;
    else timeline.toHour = timeline.fromHour + 1;
  }
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TIMELINE_STORAGE_KEY, JSON.stringify(timeline));
});

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function appointmentColor(appointment: AppointmentListItem): string | null {
  if (!canPlanAllAppointments.value) return null;
  const teacher = appointment.teachers?.[0] ?? appointment.teacher;
  return teacher ? avatarColor(teacher.id, teacher.color) : null;
}

function teachersCaption(appointment: AppointmentListItem) {
  return formatTeachersCaption(appointment, {
    teacherProfileId: primaryTenant.value?.teacherProfileId,
    canManageTenant: canPlanAllAppointments.value,
    teacherLabel: teacherLabel.value,
  });
}

function getMondayOf(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function firstOfMonth(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

const DEFAULT_STATUS_FILTER = "draft,confirmed";

const filters = reactive({
  q: "",
  teacherId: "",
  lessonTypeId: "",
  status: DEFAULT_STATUS_FILTER,
  from: "",
  to: "",
});
const page = ref(1);
const pageSize = ref(25);

const filterAutoApply = useFilterAutoApply(
  () => [filters.q, filters.teacherId, filters.lessonTypeId, filters.status, filters.from, filters.to],
  applyFilters,
  () => canLoad.value,
);

const statusOptions = computed(() => [
  { value: DEFAULT_STATUS_FILTER, label: t("appointments.statusOpen") },
  { value: "draft", label: t("appointments.statusDraft") },
  { value: "completed", label: t("appointments.statusDone") },
  { value: "cancelled", label: t("appointments.statusCancelled") },
  { value: "", label: t("common.all") },
]);

/** Einheitliche Höhe für Suche, Select und Datum im Filter. */
const filterControlUi = { base: "min-h-10 py-2.5" };
const filterSelectUi = { base: "min-h-10 w-full" };

// USelect (Reka UI) does not accept "" as an item value, so "Alle" uses a sentinel.
const ALL_FILTER_VALUE = "__all";

const teacherFilterItems = computed(() => [
  { label: t("appointments.allTeachers", { teacher: teacherLabel.value }), value: ALL_FILTER_VALUE },
  ...(options.value?.teachers ?? []).map((teacher) => ({
    label: teacher.displayName,
    value: teacher.id,
  })),
]);

const statusFilterItems = computed(() =>
  statusOptions.value.map((option) => ({ label: option.label, value: option.value || ALL_FILTER_VALUE })),
);

const lessonTypeFilterItems = computed(() => [
  { label: t("appointments.allLessonTypes"), value: ALL_FILTER_VALUE },
  ...(options.value?.lessonTypes ?? []).map((lessonType) => ({
    label: lessonType.name,
    value: lessonType.id,
  })),
]);

const lessonTypeFilterModel = computed({
  get: () => filters.lessonTypeId || ALL_FILTER_VALUE,
  set: (value: string) => {
    filters.lessonTypeId = value === ALL_FILTER_VALUE ? "" : value;
  },
});

const teacherFilterModel = computed({
  get: () => filters.teacherId || ALL_FILTER_VALUE,
  set: (value: string) => {
    filters.teacherId = value === ALL_FILTER_VALUE ? "" : value;
  },
});

const statusFilterModel = computed({
  get: () => filters.status || ALL_FILTER_VALUE,
  set: (value: string) => {
    filters.status = value === ALL_FILTER_VALUE ? "" : value;
  },
});

const canLoad = computed(() => Boolean(primaryTenant.value?.tenantId));

const filterHint = computed(() =>
  view.value === "calendar"
    ? t("appointments.filterHintCalendar")
    : t("appointments.filterHintList"),
);

const activeFilterCount = computed(() => {
  let n = 0;
  if (filters.q) n += 1;
  if (filters.teacherId) n += 1;
  if (view.value === "list") {
    if (filters.lessonTypeId) n += 1;
    if (filters.status !== DEFAULT_STATUS_FILTER) n += 1;
    if (filters.from) n += 1;
    if (filters.to) n += 1;
  }
  return n;
});

const rangeLabel = computed(() => {
  if (!pagination.value.total) return t("appointments.zero");
  const start = (pagination.value.page - 1) * pagination.value.pageSize + 1;
  const end = Math.min(pagination.value.page * pagination.value.pageSize, pagination.value.total);
  return t("appointments.range", { start, end, total: pagination.value.total });
});

function appointmentTitle(appointment: AppointmentListItem) {
  return appointment.customer?.displayName || appointment.appointmentContactText || t("appointments.noContact");
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(intlLocale.value, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function toIsoDateStart(dateValue: string) {
  return new Date(`${dateValue}T00:00:00`).toISOString();
}

function toIsoDateEndExclusive(dateValue: string) {
  const end = new Date(`${dateValue}T00:00:00`);
  end.setDate(end.getDate() + 1);
  return end.toISOString();
}

async function loadAppointments() {
  if (!primaryTenant.value?.tenantId) {
    appointments.value = [];
    return;
  }
  filterAutoApply.markApplied();
  loading.value = true;
  error.value = "";
  try {
    const isCalendar = view.value === "calendar";
    const range = isCalendar ? calendarRange.value : null;
    const fromIso = range
      ? range.from.toISOString()
      : filters.from
        ? toIsoDateStart(filters.from)
        : undefined;
    const toIso = range
      ? range.to.toISOString()
      : filters.to
        ? toIsoDateEndExclusive(filters.to)
        : undefined;
    const response = await $fetch<{ data: AppointmentListItem[]; pagination: Pagination }>(
      `/api/v1/tenants/${primaryTenant.value.tenantId}/appointments`,
      {
        credentials: "include",
        query: {
          q: filters.q || undefined,
          teacherId: filters.teacherId || undefined,
          lessonTypeId: isCalendar ? undefined : filters.lessonTypeId || undefined,
          status: isCalendar ? undefined : filters.status || undefined,
          from: fromIso,
          to: toIso,
          page: isCalendar ? 1 : page.value,
          pageSize: isCalendar ? 500 : pageSize.value,
          sort: "asc",
        },
      },
    );
    appointments.value = response.data;
    pagination.value = response.pagination;
    void loadUnavailability();
  } catch (e: unknown) {
    const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
    error.value = err.data?.data?.message || err.data?.message || err.statusMessage || t("appointments.loadFailed");
  } finally {
    loading.value = false;
  }
}

const unavailability = ref<UnavailabilityItem[]>([]);
let unavailabilityRequest = 0;

function showsUnavailability() {
  return view.value === "calendar" && (calendarMode.value === "timeline" || isWeekMode(calendarMode.value));
}

async function loadUnavailability() {
  const tenantId = primaryTenant.value?.tenantId;
  const request = ++unavailabilityRequest;
  if (!tenantId || !showsUnavailability()) {
    unavailability.value = [];
    return;
  }
  const { from, to } = calendarRange.value;
  try {
    const response = await $fetch<{ data: UnavailabilityItem[] }>(
      `/api/v1/tenants/${tenantId}/scheduling/unavailability`,
      {
        credentials: "include",
        query: { from: toDateKey(from), to: toDateKey(addDays(to, -1)) },
      },
    );
    if (request === unavailabilityRequest) unavailability.value = response.data;
  } catch {
    if (request === unavailabilityRequest) unavailability.value = [];
  }
}

function blocksFor(teacherId: string, key: string): TimelineBlock[] {
  return unavailability.value
    .filter((item) => item.teacherId === teacherId && item.date === key)
    .map((item) => ({
      id: `${item.teacherId}:${item.startsAt}:${item.kind}`,
      kind: item.kind,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      allDay: item.allDay,
      reason: item.reason,
    }));
}

/** Absences plus whole days off; partial "outside hours" ranges only clutter the week views. */
function noticesFor(teacherId: string, key: string): TimelineBlock[] {
  return blocksFor(teacherId, key).filter((block) => block.kind !== "unavailable" || block.allDay);
}

function noticeLabel(block: TimelineBlock) {
  const label = t(`blocks.${block.kind}`);
  return block.allDay ? label : `${label} ${formatTime(block.startsAt)}–${formatTime(block.endsAt)}`;
}

function noticeStyle(kind: TimelineBlockKind) {
  const color = TIMELINE_BLOCK_COLORS[kind];
  return {
    color,
    backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
  };
}

const visibleTeachers = computed(() => {
  const ownTeacherId = canPlanAllAppointments.value ? null : (primaryTenant.value?.teacherProfileId ?? "");
  return (options.value?.teachers ?? [])
    .filter((teacher) => ownTeacherId === null || teacher.id === ownTeacherId)
    .filter((teacher) => !filters.teacherId || teacher.id === filters.teacherId);
});

function weekDayNotices(key: string) {
  return visibleTeachers.value.flatMap((teacher) =>
    noticesFor(teacher.id, key).map((block) => ({ teacher, block })),
  );
}

const calendarRange = computed(() => {
  if (isDayMode(calendarMode.value)) {
    return { from: dayAnchor.value, to: addDays(dayAnchor.value, 1) };
  }
  if (isWeekMode(calendarMode.value)) {
    return { from: weekStart.value, to: addDays(weekStart.value, 7) };
  }
  const gridStart = getMondayOf(monthAnchor.value);
  return { from: gridStart, to: addDays(gridStart, 42) };
});

const weekDays = computed(() => {
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart.value, i);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date, key };
  });
});

const monthGrid = computed(() => {
  const gridStart = getMondayOf(monthAnchor.value);
  const month = monthAnchor.value.getMonth();
  return Array.from({ length: 42 }, (_, i) => {
    const date = addDays(gridStart, i);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date, key, inMonth: date.getMonth() === month };
  });
});

const weekdayHeaders = computed(() => {
  const monday = new Date(Date.UTC(2024, 0, 1));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    return new Intl.DateTimeFormat(intlLocale.value, { weekday: "short", timeZone: "UTC" }).format(date);
  });
});

function dateKey(value: string) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function appointmentsByDay(key: string) {
  return appointments.value
    .filter((a) => dateKey(a.startsAt) === key)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

function toDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const dayAppointments = computed(() => appointmentsByDay(toDateKey(dayAnchor.value)));

const dayColumns = computed(() => {
  const columns = new Map<
    string,
    { id: string; name: string; color: string | null; appointments: AppointmentListItem[] }
  >();
  const unassigned: AppointmentListItem[] = [];
  const ownTeacherId = canPlanAllAppointments.value ? null : (primaryTenant.value?.teacherProfileId ?? null);
  for (const appointment of dayAppointments.value) {
    const assigned = appointment.teachers?.length
      ? appointment.teachers
      : appointment.teacher
        ? [appointment.teacher]
        : [];
    // Co-teachers are listed on the detail page; non-planners only get their own row.
    const own = ownTeacherId ? assigned.filter((teacher) => teacher.id === ownTeacherId) : [];
    const teachers = ownTeacherId && own.length ? own : assigned;
    if (!teachers.length) {
      unassigned.push(appointment);
      continue;
    }
    for (const teacher of teachers) {
      const column = columns.get(teacher.id) ?? {
        id: teacher.id,
        name: teacher.displayName,
        color: teacher.color ?? null,
        appointments: [],
      };
      column.appointments.push(appointment);
      columns.set(teacher.id, column);
    }
  }
  const sorted = [...columns.values()].sort((a, b) => a.name.localeCompare(b.name, intlLocale.value));
  if (unassigned.length) {
    sorted.push({ id: "__unassigned", name: t("appointments.unassigned", { teacher: teacherLabel.value }), color: null, appointments: unassigned });
  }
  return sorted;
});

/** Like `dayColumns`, but every person gets a row, even without appointments that day. */
const timelineRows = computed(() => {
  const withAppointments = new Map(dayColumns.value.map((column) => [column.id, column]));
  const rows = visibleTeachers.value.map(
    (teacher) =>
      withAppointments.get(teacher.id) ?? {
        id: teacher.id,
        name: teacher.displayName,
        color: teacher.color ?? null,
        appointments: [] as AppointmentListItem[],
      },
  );
  const known = new Set(rows.map((row) => row.id));
  const extra = dayColumns.value.filter((column) => !known.has(column.id) && column.id !== UNASSIGNED_ROW_ID);
  const unassigned = withAppointments.get(UNASSIGNED_ROW_ID);
  const key = toDateKey(dayAnchor.value);
  const visible = [...rows, ...extra]
    .filter((row) => !timeline.auto || row.appointments.length > 0)
    .map((row) => ({ ...row, blocks: blocksFor(row.id, key) }));
  return [
    ...visible.sort((a, b) => a.name.localeCompare(b.name, intlLocale.value)),
    ...(unassigned ? [unassigned] : []),
  ];
});

const WEEK_DAY_VISIBLE = 8;
const TEAM_CELL_VISIBLE = 3;

const teamRows = computed(() => {
  const rows = new Map<
    string,
    { id: string; name: string; color: string | null; byDay: Map<string, AppointmentListItem[]> }
  >();
  for (const teacher of options.value?.teachers ?? []) {
    rows.set(teacher.id, { id: teacher.id, name: teacher.displayName, color: teacher.color ?? null, byDay: new Map() });
  }
  const unassigned = { id: UNASSIGNED_ROW_ID, name: t("appointments.unassigned", { teacher: teacherLabel.value }), color: null, byDay: new Map() };
  const sortedAppointments = [...appointments.value].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  for (const appointment of sortedAppointments) {
    const key = dateKey(appointment.startsAt);
    const teachers = appointment.teachers?.length
      ? appointment.teachers
      : appointment.teacher
        ? [appointment.teacher]
        : [];
    const targets = teachers.length
      ? teachers.map((teacher) => {
          const row = rows.get(teacher.id) ?? {
            id: teacher.id,
            name: teacher.displayName,
            color: teacher.color ?? null,
            byDay: new Map(),
          };
          rows.set(teacher.id, row);
          return row;
        })
      : [unassigned];
    for (const row of targets) {
      const list = row.byDay.get(key) ?? [];
      list.push(appointment);
      row.byDay.set(key, list);
    }
  }
  const sorted = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, intlLocale.value));
  if (unassigned.byDay.size) sorted.push(unassigned);
  return sorted;
});

function bookedHoursLabel(list: AppointmentListItem[]) {
  const minutes = list
    .filter((appointment) => appointment.status !== "cancelled")
    .reduce((sum, a) => sum + (new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60000, 0);
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${String(hours).replace(".", ",")} h`;
}

function openDay(date: Date, mode: "day" | "timeline" = "timeline") {
  dayAnchor.value = startOfDay(date);
  calendarMode.value = mode;
  persistViewPreference();
  loadAppointments();
}

function isDayMode(mode: CalendarMode) {
  return mode === "day" || mode === "timeline";
}

function isWeekMode(mode: CalendarMode) {
  return mode === "week" || mode === "team";
}

function minutesIntoDay(value: string) {
  return (new Date(value).getTime() - dayAnchor.value.getTime()) / 60000;
}

const timelineHours = computed(() => {
  if (!timeline.auto) return { from: timeline.fromHour, to: timeline.toHour };
  if (!dayAppointments.value.length) return { from: 9, to: 17 };
  let min = 24 * 60;
  let max = 0;
  for (const appointment of dayAppointments.value) {
    min = Math.min(min, minutesIntoDay(appointment.startsAt));
    max = Math.max(max, minutesIntoDay(appointment.endsAt));
  }
  const from = Math.max(0, Math.floor(min / 60));
  const to = Math.min(24, Math.max(from + 1, Math.ceil(max / 60)));
  return { from, to };
});

const timelineHiddenCount = computed(() => {
  const rangeStart = timelineHours.value.from * 60;
  const rangeEnd = timelineHours.value.to * 60;
  return dayAppointments.value.filter(
    (appointment) =>
      minutesIntoDay(appointment.endsAt) <= rangeStart || minutesIntoDay(appointment.startsAt) >= rangeEnd,
  ).length;
});

const UNASSIGNED_ROW_ID = "__unassigned";

interface AppointmentSnapshot {
  startsAt: string;
  endsAt: string;
  teacherIds: string[] | null;
}

const lastMove = ref<{ appointmentId: string; message: string; previous: AppointmentSnapshot } | null>(null);
let lastMoveTimer: ReturnType<typeof setTimeout> | undefined;

function assignedTeacherIds(appointment: AppointmentListItem): string[] {
  if (appointment.teachers?.length) return appointment.teachers.map((teacher) => teacher.id);
  return appointment.teacher ? [appointment.teacher.id] : [];
}

function nextTeacherIds(current: string[], fromRowId: string, toRowId: string): string[] {
  if (fromRowId === UNASSIGNED_ROW_ID) return toRowId === UNASSIGNED_ROW_ID ? [] : [toRowId];
  if (toRowId === UNASSIGNED_ROW_ID) return current.filter((id) => id !== fromRowId);
  if (current.includes(toRowId)) return current.filter((id) => id !== fromRowId);
  return current.map((id) => (id === fromRowId ? toRowId : id));
}

async function patchAppointmentSchedule(appointment: AppointmentListItem, body: Record<string, unknown>) {
  if (!primaryTenant.value?.tenantId) throw new Error(t("appointments.noTenant"));
  return $fetch<AppointmentListItem>(
    `/api/v1/tenants/${primaryTenant.value.tenantId}/appointments/${appointment.id}`,
    {
      method: "PATCH",
      credentials: "include",
      body,
      headers: { "If-Match": String(appointment.version) },
    },
  );
}

function replaceAppointment(updated: AppointmentListItem) {
  appointments.value = appointments.value.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
}

function showLastMove(appointmentId: string, message: string, previous: AppointmentSnapshot) {
  lastMove.value = { appointmentId, message, previous };
  if (lastMoveTimer) clearTimeout(lastMoveTimer);
  lastMoveTimer = setTimeout(() => (lastMove.value = null), 10_000);
}

async function onTimelineMove(move: TimelineMove<AppointmentListItem>) {
  const { appointment } = move;
  const teacherChanged = move.fromRowId !== move.toRowId;
  const previousTeacherIds = assignedTeacherIds(appointment);
  const body: Record<string, unknown> = {
    startsAt: move.startsAt.toISOString(),
    endsAt: move.endsAt.toISOString(),
  };
  if (teacherChanged) body.teacherIds = nextTeacherIds(previousTeacherIds, move.fromRowId, move.toRowId);

  const previous: AppointmentSnapshot = {
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    teacherIds: teacherChanged ? previousTeacherIds : null,
  };
  replaceAppointment({ ...appointment, startsAt: body.startsAt as string, endsAt: body.endsAt as string });
  savingId.value = appointment.id;
  error.value = "";
  try {
    const updated = await patchAppointmentSchedule(appointment, body);
    replaceAppointment(updated);
    const target = teacherChanged
      ? t("appointments.movedTo", { name: timelineRows.value.find((row) => row.id === move.toRowId)?.name ?? teacherLabel.value })
      : "";
    showLastMove(
      appointment.id,
      `„${appointmentTitle(appointment)}“ ${formatTime(updated.startsAt)}–${formatTime(updated.endsAt)}${target}`,
      previous,
    );
  } catch (e: unknown) {
    const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
    error.value =
      err.data?.data?.message || err.data?.message || err.statusMessage || t("appointments.moveFailed");
    await loadAppointments();
  } finally {
    savingId.value = "";
  }
}

async function undoLastMove() {
  const move = lastMove.value;
  if (!move) return;
  const appointment = appointments.value.find((item) => item.id === move.appointmentId);
  lastMove.value = null;
  if (!appointment) return;
  const body: Record<string, unknown> = { startsAt: move.previous.startsAt, endsAt: move.previous.endsAt };
  if (move.previous.teacherIds) body.teacherIds = move.previous.teacherIds;
  savingId.value = appointment.id;
  error.value = "";
  try {
    replaceAppointment(await patchAppointmentSchedule(appointment, body));
  } catch (e: unknown) {
    const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
    error.value =
      err.data?.data?.message || err.data?.message || err.statusMessage || t("appointments.undoFailed");
    await loadAppointments();
  } finally {
    savingId.value = "";
  }
}

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function formatDayHeader(date: Date) {
  return new Intl.DateTimeFormat(intlLocale.value, { weekday: "short", day: "2-digit", month: "2-digit" }).format(date);
}

function formatTime(value: string | Date) {
  return new Intl.DateTimeFormat(intlLocale.value, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

const calendarRangeLabel = computed(() => {
  if (isDayMode(calendarMode.value)) {
    return new Intl.DateTimeFormat(intlLocale.value, {
      weekday: "long",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(dayAnchor.value);
  }
  if (isWeekMode(calendarMode.value)) {
    const start = weekStart.value;
    const end = addDays(start, 6);
    const fmt = new Intl.DateTimeFormat(intlLocale.value, { day: "2-digit", month: "2-digit", year: "numeric" });
    return `${fmt.format(start)} – ${fmt.format(end)}`;
  }
  const fmt = new Intl.DateTimeFormat(intlLocale.value, { month: "long", year: "numeric" });
  return fmt.format(monthAnchor.value);
});

function shiftCalendar(direction: 1 | -1) {
  if (isDayMode(calendarMode.value)) {
    dayAnchor.value = addDays(dayAnchor.value, direction);
  } else if (isWeekMode(calendarMode.value)) {
    weekStart.value = addDays(weekStart.value, direction * 7);
  } else {
    monthAnchor.value = addMonths(monthAnchor.value, direction);
  }
  loadAppointments();
}

function goToToday() {
  const today = new Date();
  dayAnchor.value = startOfDay(today);
  weekStart.value = getMondayOf(today);
  monthAnchor.value = firstOfMonth(today);
  loadAppointments();
}

function isWithin(date: Date, from: Date, to: Date) {
  return date.getTime() >= from.getTime() && date.getTime() < to.getTime();
}

function setCalendarMode(next: CalendarMode) {
  if (calendarMode.value === next) return;
  const previous = calendarMode.value;
  const today = startOfDay(new Date());
  if (isDayMode(next) && !isDayMode(previous)) {
    const { from, to } = calendarRange.value;
    if (isWeekMode(previous)) {
      if (!isWithin(dayAnchor.value, from, to)) {
        dayAnchor.value = isWithin(today, from, to) ? today : from;
      }
    } else {
      const monthStart = monthAnchor.value;
      const monthEnd = addMonths(monthStart, 1);
      if (!isWithin(dayAnchor.value, monthStart, monthEnd)) {
        dayAnchor.value = isWithin(today, monthStart, monthEnd) ? today : monthStart;
      }
    }
  } else if (isWeekMode(next)) {
    if (!isWeekMode(previous)) {
      weekStart.value = getMondayOf(isDayMode(previous) ? dayAnchor.value : monthAnchor.value);
    }
  } else if (next === "month") {
    monthAnchor.value = firstOfMonth(isDayMode(previous) ? dayAnchor.value : weekStart.value);
  }
  calendarMode.value = next;
  persistViewPreference();
  loadAppointments();
}

function setView(next: AppointmentsView) {
  if (view.value === next) return;
  view.value = next;
  if (next === "calendar") {
    filters.from = "";
    filters.to = "";
    goToToday();
  } else {
    page.value = 1;
    loadAppointments();
  }
  persistViewPreference();
}

function isToday(date: Date) {
  const t = new Date();
  return (
    date.getFullYear() === t.getFullYear() &&
    date.getMonth() === t.getMonth() &&
    date.getDate() === t.getDate()
  );
}

async function loadOptions() {
  if (!primaryTenant.value?.tenantId) return;
  try {
    options.value = await $fetch<SchedulingOptions>(
      `/api/v1/tenants/${primaryTenant.value.tenantId}/scheduling/options`,
      { credentials: "include" },
    );
  } catch {
    options.value = null;
  }
}

function openQuickCapture() {
  editingAppointment.value = null;
  quickDuplicateSeed.value = null;
  quickInitialContact.value = "";
  quickInitialStartsAt.value = "";
  quickInitialTeacherId.value = "";
  quickStartVoice.value = false;
  quickOpen.value = true;
}

function onTimelineCreate(create: TimelineCreate) {
  openQuickCapture();
  quickInitialStartsAt.value = create.startsAt.toISOString();
  quickInitialTeacherId.value = create.rowId === UNASSIGNED_ROW_ID ? "" : create.rowId;
}

function canCompleteAppointment(appointment: AppointmentListItem) {
  return canAccessWorkspace.value && appointment.status !== "completed" && appointment.status !== "cancelled";
}

function timelineMenuItems(appointment: AppointmentListItem): DropdownMenuItem[][] {
  const groups: DropdownMenuItem[][] = [
    [
      { label: t("appointments.edit"), icon: "i-lucide-pencil", onSelect: () => openEditAppointment(appointment) },
      ...(canAccessWorkspace.value
        ? [{ label: t("appointments.duplicate"), icon: "i-lucide-copy-plus", onSelect: () => openDuplicateAppointment(appointment) }]
        : []),
      ...(canCompleteAppointment(appointment)
        ? [{ label: t("appointments.markDone"), icon: "i-lucide-check", onSelect: () => markCompleted(appointment) }]
        : []),
    ],
  ];
  if (canAccessWorkspace.value) {
    groups.push([
      {
        label: t("appointments.copyMenu"),
        icon: "i-lucide-copy",
        onSelect: () => openCopyDialog(appointment),
      },
    ]);
  }
  if (canAccessWorkspace.value) {
    groups.push([
      { label: t("appointments.delete"), icon: "i-lucide-trash-2", color: "error", onSelect: () => deleteAppointment(appointment) },
    ]);
  }
  return groups;
}

// --- Copy to other days ---------------------------------------------------

const copySource = ref<AppointmentListItem | null>(null);
const copyDates = shallowRef<CalendarDate[]>([]);
const copySaving = ref(false);
const copyFailures = ref<{ date: string; message: string }[]>([]);

const copyOpen = computed({
  get: () => Boolean(copySource.value),
  set: (open: boolean) => {
    if (!open && !copySaving.value) copySource.value = null;
  },
});

function toCalendarDate(date: Date) {
  return new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function fromCalendarDate(value: DateValue) {
  return new Date(value.year, value.month - 1, value.day);
}

function openCopyDialog(appointment: AppointmentListItem) {
  copySource.value = appointment;
  copyDates.value = [];
  copyFailures.value = [];
}

const copyCalendarModel = computed({
  get: () => copyDates.value,
  set: (value: DateValue | DateValue[] | undefined | null) => {
    const list = Array.isArray(value) ? value : value ? [value] : [];
    copyDates.value = list
      .map((item) => new CalendarDate(item.year, item.month, item.day))
      .sort((a, b) => a.compare(b));
  },
});

function isCopySourceDay(value: DateValue) {
  return Boolean(copySource.value && toCalendarDate(new Date(copySource.value.startsAt)).compare(value) === 0);
}

function formatCopyDate(value: CalendarDate) {
  return new Intl.DateTimeFormat(intlLocale.value, { weekday: "short", day: "2-digit", month: "2-digit" }).format(
    fromCalendarDate(value),
  );
}

function copyBody(source: AppointmentListItem, day: CalendarDate) {
  const originalStart = new Date(source.startsAt);
  const startsAt = new Date(
    day.year,
    day.month - 1,
    day.day,
    originalStart.getHours(),
    originalStart.getMinutes(),
  );
  const duration = new Date(source.endsAt).getTime() - originalStart.getTime();
  return {
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + duration).toISOString(),
    status: source.status === "draft" ? "draft" : "confirmed",
    teacherIds: assignedTeacherIds(source),
    lessonTypeId: source.lessonType?.id ?? null,
    resourceId: resourcesEnabled.value ? (source.resource?.id ?? null) : null,
    customerId: source.customer?.id ?? null,
    appointmentContactText: source.appointmentContactText,
    appointmentPhoneRaw: source.appointmentPhoneRaw,
    appointmentPhoneE164: source.appointmentPhoneE164,
    unstructuredNote: source.unstructuredNote,
  };
}

async function runCopy() {
  const source = copySource.value;
  const tenantId = primaryTenant.value?.tenantId;
  if (!source || !tenantId || !copyDates.value.length) return;
  copySaving.value = true;
  copyFailures.value = [];
  const failed: CalendarDate[] = [];
  for (const day of copyDates.value) {
    try {
      await $fetch(`/api/v1/tenants/${tenantId}/appointments`, {
        method: "POST",
        credentials: "include",
        body: copyBody(source, day),
      });
    } catch (e: unknown) {
      failed.push(day);
      copyFailures.value.push({ date: formatCopyDate(day), message: apiErrorMessage(e, t("appointments.copyFailed")) });
    }
  }
  copySaving.value = false;
  copyDates.value = failed;
  if (!failed.length) copySource.value = null;
  await loadAppointments();
}

function apiErrorMessage(e: unknown, fallback: string) {
  const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
  return err.data?.data?.message || err.data?.message || err.statusMessage || fallback;
}

// --- Jump to date ---------------------------------------------------------

const datePickerOpen = ref(false);

const datePickerValue = computed(() => {
  if (isDayMode(calendarMode.value)) return toCalendarDate(dayAnchor.value);
  if (isWeekMode(calendarMode.value)) return toCalendarDate(weekStart.value);
  return toCalendarDate(monthAnchor.value);
});

function jumpToDate(value: DateValue | DateValue[] | undefined | null) {
  if (!value || Array.isArray(value)) return;
  const date = fromCalendarDate(value);
  dayAnchor.value = startOfDay(date);
  weekStart.value = getMondayOf(date);
  monthAnchor.value = firstOfMonth(date);
  datePickerOpen.value = false;
  loadAppointments();
}

function openAssistant() {
  editingAppointment.value = null;
  quickDuplicateSeed.value = null;
  quickInitialContact.value = "";
  quickInitialStartsAt.value = "";
  quickInitialTeacherId.value = "";
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
  quickInitialStartsAt.value = "";
  quickInitialTeacherId.value = "";
  quickStartVoice.value = false;
  quickOpen.value = true;
}

function openDuplicateAppointment(appointment: AppointmentListItem) {
  editingAppointment.value = null;
  quickDuplicateSeed.value = toQuickCaptureDuplicateSeed(appointment);
  quickInitialContact.value = "";
  quickInitialStartsAt.value = "";
  quickInitialTeacherId.value = "";
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

function applyFilters() {
  page.value = 1;
  loadAppointments();
}

function resetFilters() {
  filters.q = "";
  filters.teacherId = "";
  if (view.value === "list") {
    filters.lessonTypeId = "";
    filters.status = DEFAULT_STATUS_FILTER;
    filters.from = "";
    filters.to = "";
  }
  page.value = 1;
  loadAppointments();
}

async function markCompleted(appointment: AppointmentListItem) {
  if (!primaryTenant.value?.tenantId) return;
  savingId.value = appointment.id;
  error.value = "";
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
    error.value =
      err.data?.data?.message || err.data?.message || err.statusMessage || t("appointments.completeFailed");
  } finally {
    savingId.value = "";
  }
}

async function deleteAppointment(appointment: AppointmentListItem) {
  if (!primaryTenant.value?.tenantId) return;
  if (!confirm(t("appointments.deleteConfirm", { title: appointmentTitle(appointment) }))) return;
  savingId.value = appointment.id;
  error.value = "";
  try {
    await $fetch(`/api/v1/tenants/${primaryTenant.value.tenantId}/appointments/${appointment.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    await loadAppointments();
  } catch (e: unknown) {
    const err = e as { data?: { data?: { message?: string }; message?: string }; statusMessage?: string };
    error.value =
      err.data?.data?.message || err.data?.message || err.statusMessage || t("appointments.deleteFailed");
  } finally {
    savingId.value = "";
  }
}

function goToPage(target: number) {
  const next = Math.max(1, Math.min(pagination.value.totalPages, target));
  if (next === page.value) return;
  page.value = next;
  loadAppointments();
}

watch(pageSize, () => {
  page.value = 1;
  loadAppointments();
});

watch(quickOpen, (open) => {
  if (!open) {
    editingAppointment.value = null;
    quickStartVoice.value = false;
  }
});

onBeforeUnmount(() => {
  if (lastMoveTimer) clearTimeout(lastMoveTimer);
});

onMounted(async () => {
  restoreViewPreference();
  await loadOptions();
  await loadAppointments();
  filterAutoApply.start();
});

useAppointmentListSync(loadAppointments);

watch(
  () => primaryTenant.value?.tenantId,
  async () => {
    page.value = 1;
    await loadOptions();
    await loadAppointments();
  },
);
</script>

<template>
  <UContainer class="py-8 space-y-5">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <p class="text-sm text-muted font-medium">{{ t("appointments.breadcrumb") }}</p>
        <h1 class="font-display text-3xl sm:text-4xl">
          {{ t("appointments.title") }}
          <span class="ml-2 text-sm font-normal text-neutral-500">({{ pagination.total }})</span>
        </h1>
        <p v-if="!canManageTenant" class="mt-1 text-sm text-neutral-500">
          {{ canPlanAllAppointments ? "" : t("appointments.ownOnly") }}{{ t("appointments.deleteAdminOnly") }}
        </p>
      </div>
      <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
        <div class="inline-flex rounded-md border border-neutral-300 dark:border-neutral-700 overflow-hidden">
          <button
            type="button"
            class="px-2 sm:px-3 py-1.5 text-sm flex items-center gap-1 transition"
            :class="
              view === 'list'
                ? 'bg-primary-100 text-primary-900 dark:bg-primary-900/40 dark:text-primary-100'
                : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
            "
            :aria-label="t('appointments.listView')"
            :title="t('appointments.list')"
            @click="setView('list')"
          >
            <UIcon name="i-lucide-list" class="size-4" />
            <span class="hidden sm:inline">{{ t("appointments.list") }}</span>
          </button>
          <button
            type="button"
            class="px-2 sm:px-3 py-1.5 text-sm flex items-center gap-1 border-l border-neutral-300 dark:border-neutral-700 transition"
            :class="
              view === 'calendar'
                ? 'bg-primary-100 text-primary-900 dark:bg-primary-900/40 dark:text-primary-100'
                : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
            "
            :aria-label="t('appointments.calendarView')"
            :title="t('appointments.calendar')"
            @click="setView('calendar')"
          >
            <UIcon name="i-lucide-calendar-range" class="size-4" />
            <span class="hidden sm:inline">{{ t("appointments.calendar") }}</span>
          </button>
        </div>
        <UButton
          variant="outline"
          color="neutral"
          icon="i-lucide-filter"
          :aria-label="t('common.filter')"
          :title="t('common.filter')"
          @click="filterOpen = !filterOpen"
        >
          <span class="hidden sm:inline">{{ t("common.filter") }}</span>
          <UBadge v-if="activeFilterCount" color="primary" variant="subtle" class="sm:ml-1">
            {{ activeFilterCount }}
          </UBadge>
          <UIcon
            :name="filterOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            class="ml-1 size-4 hidden sm:inline-flex"
          />
        </UButton>
        <UButton
          v-if="canAccessWorkspace && speechRecognitionEnabled"
          variant="outline"
          color="neutral"
          icon="i-lucide-message-circle-question"
          :aria-label="t('appointments.assistant')"
          :title="t('appointments.assistant')"
          @click="openAssistant"
        >
          <span class="hidden sm:inline">{{ t("appointments.assistant") }}</span>
        </UButton>
        <UButton
          v-if="canAccessWorkspace"
          icon="i-lucide-plus"
          color="primary"
          :aria-label="t('appointments.new')"
          :title="t('appointments.new')"
          @click="openQuickCapture"
        >
          <span class="hidden sm:inline">{{ t("appointments.new") }}</span>
        </UButton>
      </div>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :title="error"
    />

    <UCard
      v-if="filterOpen"
      :ui="{
        header: 'px-4 py-3 sm:px-5 border-b border-neutral-200/80 dark:border-neutral-800',
        body: 'px-4 py-4 sm:px-5',
        footer: 'px-4 py-3 sm:px-5 border-t border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/80 dark:bg-neutral-900/40',
      }"
    >
      <template #header>
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 space-y-1">
            <h2 class="font-medium text-neutral-900 dark:text-neutral-100">{{ t("common.filter") }}</h2>
            <p class="text-sm text-neutral-500 dark:text-neutral-400 leading-snug">
              {{ filterHint }}
            </p>
          </div>
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-x"
            class="shrink-0"
            @click="filterOpen = false"
          />
        </div>
      </template>

      <div
        class="grid gap-x-4 gap-y-4"
        :class="
          view === 'calendar'
            ? 'sm:grid-cols-2 max-w-2xl'
            : 'sm:grid-cols-2 lg:grid-cols-3'
        "
      >
        <UFormField :label="t('common.searchLabel')" class="min-w-0 sm:col-span-2 lg:col-span-1">
          <UInput
            v-model="filters.q"
            size="md"
            class="w-full"
            :placeholder="t('appointments.searchPlaceholder')"
            icon="i-lucide-search"
            :ui="filterControlUi"
          />
        </UFormField>
        <UFormField v-if="canPlanAllAppointments" :label="teacherLabel" class="min-w-0">
          <USelect
            v-model="teacherFilterModel"
            size="md"
            :items="teacherFilterItems"
            class="w-full"
            :ui="filterSelectUi"
          />
        </UFormField>
        <template v-if="view === 'list'">
          <UFormField :label="t('common.lessonType')" class="min-w-0">
            <USelect
              v-model="lessonTypeFilterModel"
              size="md"
              :items="lessonTypeFilterItems"
              class="w-full"
              :ui="filterSelectUi"
            />
          </UFormField>
          <UFormField :label="t('common.status')" class="min-w-0">
            <USelect
              v-model="statusFilterModel"
              size="md"
              :items="statusFilterItems"
              class="w-full"
              :ui="filterSelectUi"
            />
          </UFormField>
          <UFormField :label="t('common.from')" class="min-w-0">
            <UInput
              v-model="filters.from"
              type="date"
              size="md"
              class="w-full"
              :ui="filterControlUi"
            />
          </UFormField>
          <UFormField :label="t('common.to')" class="min-w-0">
            <UInput
              v-model="filters.to"
              type="date"
              size="md"
              class="w-full"
              :ui="filterControlUi"
            />
          </UFormField>
        </template>
      </div>

      <template #footer>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="inline-flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
            <UIcon name="i-lucide-timer" class="size-3.5 shrink-0 opacity-80" />
            {{ t("common.autoApply") }}
          </p>
          <div class="flex items-center gap-2">
            <UButton size="sm" variant="ghost" color="neutral" @click="resetFilters">
              {{ t("common.reset") }}
            </UButton>
            <UButton
              size="sm"
              variant="soft"
              color="primary"
              :disabled="!canLoad"
              :loading="loading"
              @click="applyFilters"
            >
              {{ t("common.loadNow") }}
            </UButton>
          </div>
        </div>
      </template>
    </UCard>

    <template v-if="view === 'list'">
      <div class="flex items-center justify-between gap-3 text-sm text-neutral-600 dark:text-neutral-400">
        <span>{{ rangeLabel }}</span>
        <div class="flex items-center gap-2">
          <span>{{ t("common.perPage") }}</span>
          <select
            v-model.number="pageSize"
            class="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
          >
            <option :value="10">10</option>
            <option :value="25">25</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </div>
      </div>

      <div v-if="!primaryTenant" class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-sm text-neutral-600 dark:text-neutral-400">
        {{ t("appointments.membershipRequired") }}
      </div>
      <div v-else-if="!appointments.length && !loading" class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-sm text-neutral-600 dark:text-neutral-400">
        {{ t("appointments.noMatches") }}
      </div>
      <div v-else class="space-y-3">
        <UCard v-for="appointment in appointments" :key="appointment.id">
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
                <span v-if="teachersCaption(appointment)" class="inline-flex items-center gap-1.5">
                  <span
                    v-if="appointmentColor(appointment)"
                    class="size-2 shrink-0 rounded-full"
                    :style="{ backgroundColor: appointmentColor(appointment)! }"
                  />
                  {{ teachersCaption(appointment) }}
                </span>
                <span v-if="resourcesEnabled && appointment.resource">{{ t("appointments.resource") }}: {{ appointment.resource.name }}</span>
                <span v-if="appointment.lessonType">{{ t("appointments.type") }}: {{ appointment.lessonType.name }}</span>
              </div>
            </button>
            <AppointmentQuickActions
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
        </UCard>
      </div>

      <div
        v-if="pagination.totalPages > 1"
        class="flex items-center justify-between gap-3 pt-2"
      >
        <UButton
          size="sm"
          variant="outline"
          color="neutral"
          icon="i-lucide-chevron-left"
          :disabled="pagination.page <= 1 || loading"
          @click="goToPage(pagination.page - 1)"
        >
          {{ t("common.back") }}
        </UButton>
        <span class="text-sm text-neutral-600 dark:text-neutral-400">
          {{ t("common.pageOf", { page: pagination.page, total: pagination.totalPages }) }}
        </span>
        <UButton
          size="sm"
          variant="outline"
          color="neutral"
          trailing-icon="i-lucide-chevron-right"
          :disabled="pagination.page >= pagination.totalPages || loading"
          @click="goToPage(pagination.page + 1)"
        >
          {{ t("common.next") }}
        </UButton>
      </div>
    </template>

    <template v-else>
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-2 flex-wrap">
          <div class="inline-flex rounded-md border border-neutral-300 dark:border-neutral-700 overflow-hidden">
            <button
              type="button"
              class="px-3 py-1.5 text-sm transition"
              :class="
                calendarMode === 'day'
                  ? 'bg-primary-100 text-primary-900 dark:bg-primary-900/40 dark:text-primary-100'
                  : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              "
              @click="setCalendarMode('day')"
            >
              {{ t("appointments.day") }}
            </button>
            <button
              type="button"
              class="px-3 py-1.5 text-sm border-l border-neutral-300 dark:border-neutral-700 transition"
              :class="
                calendarMode === 'timeline'
                  ? 'bg-primary-100 text-primary-900 dark:bg-primary-900/40 dark:text-primary-100'
                  : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              "
              @click="setCalendarMode('timeline')"
            >
              {{ t("appointments.timeline") }}
            </button>
            <button
              type="button"
              class="px-3 py-1.5 text-sm border-l border-neutral-300 dark:border-neutral-700 transition"
              :class="
                calendarMode === 'week' || (calendarMode === 'team' && !canPlanAllAppointments)
                  ? 'bg-primary-100 text-primary-900 dark:bg-primary-900/40 dark:text-primary-100'
                  : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              "
              @click="setCalendarMode('week')"
            >
              {{ t("appointments.week") }}
            </button>
            <button
              v-if="canPlanAllAppointments"
              type="button"
              class="px-3 py-1.5 text-sm border-l border-neutral-300 dark:border-neutral-700 transition"
              :class="
                calendarMode === 'team'
                  ? 'bg-primary-100 text-primary-900 dark:bg-primary-900/40 dark:text-primary-100'
                  : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              "
              :title="t('appointments.teamWeek')"
              @click="setCalendarMode('team')"
            >
              Team
            </button>
            <button
              type="button"
              class="px-3 py-1.5 text-sm border-l border-neutral-300 dark:border-neutral-700 transition"
              :class="
                calendarMode === 'month'
                  ? 'bg-primary-100 text-primary-900 dark:bg-primary-900/40 dark:text-primary-100'
                  : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
              "
              @click="setCalendarMode('month')"
            >
              {{ t("appointments.month") }}
            </button>
          </div>
          <div class="flex items-center gap-1">
            <UButton size="sm" variant="outline" color="neutral" icon="i-lucide-chevron-left" @click="shiftCalendar(-1)" />
            <UButton size="sm" variant="ghost" color="neutral" @click="goToToday">{{ t("common.today") }}</UButton>
            <UButton
              size="sm"
              variant="outline"
              color="neutral"
              icon="i-lucide-calendar-search"
              :aria-label="t('appointments.pickDate')"
              :title="t('appointments.pickDate')"
              @click="datePickerOpen = true"
            />
            <UButton size="sm" variant="outline" color="neutral" icon="i-lucide-chevron-right" @click="shiftCalendar(1)" />
          </div>
        </div>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-neutral-700 capitalize transition hover:bg-neutral-100 hover:text-primary-700 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:hover:text-primary-200"
          :title="t('appointments.pickDate')"
          @click="datePickerOpen = true"
        >
          <UIcon name="i-lucide-calendar-days" class="size-4 shrink-0 opacity-70" />
          {{ calendarRangeLabel }}
        </button>
      </div>

      <div
        v-if="calendarMode === 'timeline'"
        class="flex items-center gap-x-3 gap-y-2 flex-wrap text-sm text-neutral-600 dark:text-neutral-400"
      >
        <label class="inline-flex items-center gap-1.5 cursor-pointer">
          <input v-model="timeline.auto" type="checkbox" class="rounded border-neutral-300 dark:border-neutral-700" />
          {{ t("appointments.align") }}
        </label>
        <div class="inline-flex items-center gap-1.5" :class="timeline.auto ? 'opacity-50' : ''">
          <span>{{ t("common.from") }}</span>
          <select
            v-model.number="timeline.fromHour"
            :disabled="timeline.auto"
            class="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
          >
            <option v-for="hour in 24" :key="hour - 1" :value="hour - 1">{{ formatHour(hour - 1) }}</option>
          </select>
          <span>{{ t("appointments.until") }}</span>
          <select
            v-model.number="timeline.toHour"
            :disabled="timeline.auto"
            class="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
          >
            <option v-for="hour in 24" :key="hour" :value="hour" :disabled="hour <= timeline.fromHour">
              {{ formatHour(hour) }}
            </option>
          </select>
        </div>
        <span v-if="timelineHiddenCount" class="text-xs text-amber-700 dark:text-amber-300">
          {{ t("appointments.outsideRange", { count: timelineHiddenCount }) }}
        </span>
      </div>

      <div v-if="!primaryTenant" class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-sm text-neutral-600 dark:text-neutral-400">
        {{ t("appointments.membershipRequired") }}
      </div>

      <template v-else-if="calendarMode === 'timeline'">
        <div
          v-if="!timelineRows.length && !loading"
          class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-sm text-neutral-600 dark:text-neutral-400"
        >
          <template v-if="timeline.auto">{{ t("appointments.noneToday") }}</template>
          <template v-else>{{ t("appointments.noneTodayNoTeachers", { teacher: teacherLabel }) }}</template>
        </div>
        <template v-else>
          <Transition
            enter-active-class="transition duration-200 ease-out"
            enter-from-class="opacity-0 -translate-y-1"
            leave-active-class="transition duration-150 ease-in"
            leave-to-class="opacity-0"
          >
            <div
              v-if="lastMove"
              class="flex items-center justify-between gap-3 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900 dark:border-primary-500/30 dark:bg-primary-500/10 dark:text-primary-100"
            >
              <span class="flex min-w-0 items-center gap-2">
                <UIcon name="i-lucide-check-circle-2" class="size-4 shrink-0" />
                <span class="truncate">{{ t("appointments.moved", { message: lastMove.message }) }}</span>
              </span>
              <div class="flex shrink-0 items-center gap-1">
                <UButton size="xs" variant="soft" color="primary" icon="i-lucide-undo-2" @click="undoLastMove">
                  {{ t("common.undo") }}
                </UButton>
                <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-x" @click="lastMove = null" />
              </div>
            </div>
          </Transition>
          <AppointmentTimeline
            :rows="timelineRows"
            :day="dayAnchor"
            :from-hour="timelineHours.from"
            :to-hour="timelineHours.to"
            :can-move="canAccessWorkspace"
            :can-change-row="canPlanAllAppointments"
            :can-create="canAccessWorkspace"
            :person-colors="canPlanAllAppointments"
            :saving-id="savingId"
            :show-resource="resourcesEnabled"
            :title-of="appointmentTitle"
            :format-time="formatTime"
            :menu-items="timelineMenuItems"
            @open="openEditAppointment"
            @move="onTimelineMove"
            @create="onTimelineCreate"
          />
        </template>
      </template>

      <template v-else-if="calendarMode === 'day'">
        <div
          v-if="!dayAppointments.length && !loading"
          class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 text-sm text-neutral-600 dark:text-neutral-400"
        >
          {{ t("appointments.noneToday") }}
        </div>
        <div v-else class="overflow-x-auto -mx-1 px-1 pb-1">
          <div
            class="grid gap-2"
            :style="{ gridTemplateColumns: `repeat(${Math.max(dayColumns.length, 1)}, minmax(15rem, 1fr))` }"
          >
            <div
              v-for="column in dayColumns"
              :key="column.id"
              class="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-2 flex flex-col gap-2"
            >
              <div class="flex items-center justify-between gap-2 text-sm font-medium text-neutral-700 dark:text-neutral-200">
                <span class="flex min-w-0 items-center gap-2">
                  <span
                    v-if="canPlanAllAppointments"
                    class="size-2.5 shrink-0 rounded-full"
                    :class="column.id === UNASSIGNED_ROW_ID ? 'border border-dashed border-neutral-400' : ''"
                    :style="column.id === UNASSIGNED_ROW_ID ? {} : { backgroundColor: avatarColor(column.id, column.color) }"
                  />
                  <span class="truncate">{{ column.name }}</span>
                </span>
                <span class="text-xs font-normal text-neutral-500 tabular-nums">{{ column.appointments.length }}</span>
              </div>
              <div
                v-for="appointment in column.appointments"
                :key="appointment.id"
                class="rounded-md border border-l-[3px] border-neutral-200 dark:border-neutral-800 px-2.5 py-2 text-sm bg-neutral-50 dark:bg-neutral-900"
                :style="!canPlanAllAppointments || column.id === UNASSIGNED_ROW_ID ? {} : { borderLeftColor: avatarColor(column.id, column.color) }"
              >
                <div class="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    class="min-w-0 flex-1 cursor-pointer rounded-md text-left"
                    :aria-label="t('appointment.info.open')"
                    @click="openAppointmentInfo(appointment)"
                  >
                    <div class="flex items-center gap-2">
                      <span class="font-medium tabular-nums">
                        {{ formatTime(appointment.startsAt) }}–{{ formatTime(appointment.endsAt) }}
                      </span>
                      <UBadge
                        v-if="appointmentStatusLabel(appointment.status)"
                        :color="appointmentStatusColor(appointment.status)"
                        variant="subtle"
                        size="xs"
                      >
                        {{ appointmentStatusLabel(appointment.status) }}
                      </UBadge>
                    </div>
                    <p class="mt-0.5 font-medium truncate">{{ appointmentTitle(appointment) }}</p>
                    <div class="mt-0.5 flex flex-wrap gap-x-2 text-xs text-neutral-500">
                      <span v-if="resourcesEnabled && appointment.resource">{{ appointment.resource.name }}</span>
                      <span v-if="appointment.lessonType">{{ appointment.lessonType.name }}</span>
                    </div>
                  </button>
                  <AppointmentQuickActions
                    compact
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
          </div>
        </div>
      </template>

      <div v-else-if="calendarMode === 'team' && canPlanAllAppointments" class="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table class="w-full min-w-[56rem] table-fixed border-collapse text-xs">
          <thead>
            <tr class="bg-neutral-50 dark:bg-neutral-900/60">
              <th class="sticky left-0 z-10 w-40 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900">
                {{ t("timeline.team") }}
              </th>
              <th
                v-for="day in weekDays"
                :key="day.key"
                class="border-b border-l border-neutral-200 px-2 py-1.5 text-left font-medium dark:border-neutral-800"
                :class="isToday(day.date) ? 'bg-primary-50 text-primary-800 dark:bg-primary-500/10 dark:text-primary-200' : 'text-neutral-600 dark:text-neutral-400'"
              >
                <button type="button" class="hover:text-primary-700 dark:hover:text-primary-200" :title="t('appointments.openTimeline')" @click="openDay(day.date, 'timeline')">
                  {{ formatDayHeader(day.date) }}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!teamRows.length">
              <td colspan="8" class="px-3 py-4 text-sm text-neutral-500">{{ t("appointments.noTeachers", { teacher: teacherLabel }) }}</td>
            </tr>
            <tr v-for="row in teamRows" :key="row.id" class="align-top">
              <th class="sticky left-0 z-10 border-b border-neutral-100 bg-white px-3 py-2 text-left font-normal dark:border-neutral-900 dark:bg-neutral-950">
                <div class="flex items-center gap-2">
                  <span
                    v-if="row.id !== UNASSIGNED_ROW_ID"
                    class="flex size-6 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                    :style="{ backgroundColor: avatarColor(row.id, row.color) }"
                  >
                    {{ avatarInitials(row.name) }}
                  </span>
                  <span v-else class="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-neutral-300 text-neutral-400 dark:border-neutral-700">
                    <UIcon name="i-lucide-user-x" class="size-3" />
                  </span>
                  <span class="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">{{ row.name }}</span>
                </div>
              </th>
              <td
                v-for="day in weekDays"
                :key="day.key"
                class="border-b border-l border-neutral-100 p-1 dark:border-neutral-900"
                :class="isToday(day.date) ? 'bg-primary-50/40 dark:bg-primary-500/5' : ''"
              >
                <div v-if="noticesFor(row.id, day.key).length" class="mb-1 flex flex-col gap-0.5">
                  <span
                    v-for="block in noticesFor(row.id, day.key)"
                    :key="block.id"
                    class="truncate rounded border px-1.5 py-0.5 text-[11px] font-medium"
                    :style="noticeStyle(block.kind)"
                    :title="block.reason ? `${noticeLabel(block)} · ${block.reason}` : noticeLabel(block)"
                  >
                    {{ noticeLabel(block) }}
                  </span>
                </div>
                <div v-if="row.byDay.get(day.key)?.length" class="flex flex-col gap-1">
                  <CalendarChip
                    v-for="appointment in row.byDay.get(day.key)!.slice(0, TEAM_CELL_VISIBLE)"
                    :key="appointment.id"
                    :time="formatTime(appointment.startsAt)"
                    :title="appointmentTitle(appointment)"
                    :status="appointment.status"
                    :color="row.id === UNASSIGNED_ROW_ID ? null : avatarColor(row.id, row.color)"
                    @click="openEditAppointment(appointment)"
                  />
                  <button
                    type="button"
                    class="flex items-center justify-between rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-primary-700 dark:hover:bg-neutral-800 dark:hover:text-primary-200"
                    :title="t('appointments.openTimeline')"
                    @click="openDay(day.date, 'timeline')"
                  >
                    <span v-if="row.byDay.get(day.key)!.length > TEAM_CELL_VISIBLE">
                      {{ t("appointments.more", { count: row.byDay.get(day.key)!.length - TEAM_CELL_VISIBLE }) }}
                    </span>
                    <span v-else />
                    <span class="tabular-nums">{{ bookedHoursLabel(row.byDay.get(day.key)!) }}</span>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="calendarMode === 'week' || calendarMode === 'team'" class="grid grid-cols-1 gap-2 md:grid-cols-7">
        <div
          v-for="day in weekDays"
          :key="day.key"
          class="flex min-w-0 flex-col gap-1.5 rounded-lg border bg-white p-1.5 md:min-h-[140px] dark:bg-neutral-950 cursor-pointer transition hover:border-primary-300 dark:hover:border-primary-700"
          :class="
            isToday(day.date)
              ? 'border-primary-300 dark:border-primary-700 ring-1 ring-primary-200 dark:ring-primary-900/40'
              : 'border-neutral-200 dark:border-neutral-800'
          "
          :title="t('appointments.openTimeline')"
          @click="openDay(day.date)"
        >
          <button
            type="button"
            class="flex items-center justify-between px-0.5 text-left text-xs font-medium text-neutral-600 hover:text-primary-700 dark:text-neutral-400 dark:hover:text-primary-200"
            :title="t('appointments.openTimeline')"
            @click.stop="openDay(day.date)"
          >
            <span>{{ formatDayHeader(day.date) }}</span>
            <span v-if="appointmentsByDay(day.key).length" class="font-normal tabular-nums text-neutral-400">
              {{ appointmentsByDay(day.key).length }}
            </span>
          </button>
          <div v-if="weekDayNotices(day.key).length" class="flex flex-col gap-0.5">
            <span
              v-for="notice in weekDayNotices(day.key)"
              :key="notice.block.id"
              class="truncate rounded border px-1.5 py-0.5 text-[11px] font-medium"
              :style="noticeStyle(notice.block.kind)"
              :title="[notice.teacher.displayName, noticeLabel(notice.block), notice.block.reason].filter(Boolean).join(' · ')"
            >
              <template v-if="canPlanAllAppointments">{{ notice.teacher.displayName }} · </template>{{ noticeLabel(notice.block) }}
            </span>
          </div>
          <CalendarChip
            v-for="appointment in appointmentsByDay(day.key).slice(0, WEEK_DAY_VISIBLE)"
            :key="appointment.id"
            :time="formatTime(appointment.startsAt)"
            :title="appointmentTitle(appointment)"
            :status="appointment.status"
            :color="appointmentColor(appointment)"
            :person-name="canPlanAllAppointments ? (appointment.teachers?.[0] ?? appointment.teacher)?.displayName : null"
            @click.stop="openEditAppointment(appointment)"
          />
          <button
            v-if="appointmentsByDay(day.key).length > WEEK_DAY_VISIBLE"
            type="button"
            class="rounded px-1.5 py-1 text-left text-[11px] font-medium text-primary-700 hover:bg-primary-50 dark:text-primary-300 dark:hover:bg-primary-500/10"
            @click.stop="openDay(day.date)"
          >
            {{ t("appointments.more", { count: appointmentsByDay(day.key).length - WEEK_DAY_VISIBLE }) }}
          </button>
          <p v-if="!appointmentsByDay(day.key).length" class="px-0.5 text-xs italic text-neutral-400">{{ t("appointments.none") }}</p>
        </div>
      </div>

      <div v-else class="space-y-1">
        <div class="grid grid-cols-7 gap-px sm:gap-1 text-[10px] sm:text-xs font-medium text-neutral-500 dark:text-neutral-400">
          <div v-for="header in weekdayHeaders" :key="header" class="px-0.5 sm:px-2 py-1 text-center sm:text-left">
            {{ header }}
          </div>
        </div>
        <div class="grid grid-cols-7 gap-px sm:gap-1">
          <div
            v-for="day in monthGrid"
            :key="day.key"
            class="rounded-md border min-h-[72px] sm:min-h-[110px] p-0.5 sm:p-1.5 flex flex-col gap-0.5 sm:gap-1 transition overflow-hidden cursor-pointer hover:border-primary-300 dark:hover:border-primary-700"
            :class="[
              day.inMonth
                ? 'bg-white dark:bg-neutral-950'
                : 'bg-neutral-50 dark:bg-neutral-900/50 text-neutral-400',
              isToday(day.date)
                ? 'border-primary-300 dark:border-primary-700 ring-1 ring-primary-200 dark:ring-primary-900/40'
                : 'border-neutral-200 dark:border-neutral-800',
            ]"
            :title="t('appointments.openTimeline')"
            @click="openDay(day.date)"
          >
            <div class="flex items-center justify-center sm:justify-end text-[11px] sm:text-xs">
              <span
                class="font-medium tabular-nums"
                :class="isToday(day.date) ? 'text-primary-700 dark:text-primary-200' : ''"
              >
                {{ day.date.getDate() }}
              </span>
            </div>
            <div class="flex flex-col gap-0.5 sm:gap-1 min-w-0">
              <button
                v-for="appointment in appointmentsByDay(day.key).slice(0, 3)"
                :key="appointment.id"
                type="button"
                class="rounded px-0.5 sm:px-1.5 py-0.5 text-[9px] sm:text-[11px] leading-tight border truncate text-left"
                :class="{
                  'bg-primary-50 dark:bg-primary-900/30 border-primary-200 dark:border-primary-800 text-primary-900 dark:text-primary-100':
                    appointment.status === 'confirmed',
                  'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100':
                    appointment.status === 'completed',
                  'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100':
                    appointment.status === 'draft',
                  'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 line-through':
                    appointment.status === 'cancelled',
                }"
                :title="`${formatTime(appointment.startsAt)} ${appointmentTitle(appointment)}`"
                @click.stop="openEditAppointment(appointment)"
              >
                <span
                  v-if="appointmentColor(appointment)"
                  class="mr-0.5 inline-block size-1.5 rounded-full align-middle sm:mr-1 sm:size-2"
                  :style="{ backgroundColor: appointmentColor(appointment)! }"
                />
                <span class="font-medium tabular-nums">{{ formatTime(appointment.startsAt) }}</span>
                <span class="ml-0.5 hidden sm:inline">{{ appointmentTitle(appointment) }}</span>
              </button>
              <button
                v-if="appointmentsByDay(day.key).length > 3"
                type="button"
                class="text-[9px] sm:text-[11px] text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 text-left truncate"
                @click.stop="openDay(day.date)"
              >
                +{{ appointmentsByDay(day.key).length - 3 }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

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
              : `${quickStartVoice ? 'voice' : 'type'}-${quickInitialContact || 'empty'}-${quickInitialStartsAt}-${quickInitialTeacherId}`)
          "
          :appointment="quickCaptureAppointment"
          :initial-contact-text="quickInitialContact"
          :initial-starts-at="quickInitialStartsAt || undefined"
          :initial-teacher-id="quickInitialTeacherId || undefined"
          :start-with-voice="quickStartVoice"
          @saved="onAppointmentSaved"
          @cancel="closeQuickCapture"
        />
      </template>
    </UModal>

    <UModal v-model:open="datePickerOpen" :title="t('appointments.pickDate')" :ui="{ content: 'max-w-sm' }">
      <template #body>
        <UCalendar
          :model-value="datePickerValue"
          fixed-weeks
          class="mx-auto"
          @update:model-value="jumpToDate"
        />
        <div class="mt-3 flex justify-center">
          <UButton
            size="sm"
            variant="soft"
            color="neutral"
            icon="i-lucide-calendar-check"
            @click="jumpToDate(toCalendarDate(new Date()))"
          >
            {{ t("common.today") }}
          </UButton>
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="copyOpen"
      :title="t('appointments.copyTitle')"
      :dismissible="!copySaving"
      :ui="{ content: 'max-w-md' }"
    >
      <template #body>
        <div v-if="copySource" class="space-y-4">
          <div class="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            <p class="font-medium">{{ appointmentTitle(copySource) }}</p>
            <p class="text-xs text-neutral-500 tabular-nums">
              {{ formatTime(copySource.startsAt) }}–{{ formatTime(copySource.endsAt) }}
              <template v-if="teachersCaption(copySource)"> · {{ teachersCaption(copySource) }}</template>
              · {{ t("appointments.timeStays") }}
            </p>
          </div>
          <p class="text-xs text-neutral-500">
            {{ t("appointments.clickDays") }}
          </p>
          <UCalendar
            v-model="copyCalendarModel"
            multiple
            :is-date-disabled="isCopySourceDay"
            fixed-weeks
            class="mx-auto"
          />
          <div v-if="copyDates.length" class="flex flex-wrap gap-1.5">
            <UBadge v-for="day in copyDates" :key="day.toString()" color="primary" variant="subtle">
              {{ formatCopyDate(day) }}
            </UBadge>
          </div>
          <UAlert
            v-if="copyFailures.length"
            color="error"
            variant="soft"
            icon="i-lucide-circle-alert"
            :title="t('appointments.copyFailedTitle')"
          >
            <template #description>
              <ul class="space-y-0.5">
                <li v-for="failure in copyFailures" :key="failure.date">
                  <span class="font-medium">{{ failure.date }}:</span> {{ failure.message }}
                </li>
              </ul>
            </template>
          </UAlert>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" :disabled="copySaving" @click="copyOpen = false">{{ t("common.cancel") }}</UButton>
          <UButton
            color="primary"
            icon="i-lucide-copy"
            :loading="copySaving"
            :disabled="!copyDates.length"
            @click="runCopy"
          >
            {{ copyDates.length > 1 ? t("appointments.copyMany", { count: copyDates.length }) : t("appointments.copyOne") }}
          </UButton>
        </div>
      </template>
    </UModal>
  </UContainer>
</template>
