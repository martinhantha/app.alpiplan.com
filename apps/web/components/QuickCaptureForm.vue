<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { $fetch } from "ofetch";
import type { CallHint } from "@alpiplan/device-capabilities";
import { isCallHintsOptIn } from "@alpiplan/device-capabilities";
import { useAuth } from "../composables/useAuth";
import { useDeviceCapabilities } from "../composables/useDeviceCapabilities";
import { useDeviceContactLookup } from "../composables/useDeviceContactLookup";
import type { ClarifyingQuestion, ParseIntentResponse, ParsedAppointmentIntent } from "../types/assistant";
import {
  fallbackContactDisplayName,
  resolveAppointmentPhone,
  resolveContactOrganization,
} from "../utils/appointment-contact";
import { commitUtterance, pickTranscript, withLiveInterim } from "../utils/speech-transcript";
import { isNativeAndroidSpeech, startNativeSpeech } from "../utils/native-speech";
import { appointmentStatusColor, type AppointmentStatus } from "../utils/appointment-status";
import { CALL_STATE_EVENT } from "../utils/call-state";

type WebSpeechRecognitionEventResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type WebSpeechRecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<WebSpeechRecognitionEventResult>;
};
type WebSpeechRecognitionErrorEvent = { error?: string; message?: string };
interface WebSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: WebSpeechRecognitionEvent) => void) | null;
  onerror: ((event: WebSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type WebSpeechCtor = new () => WebSpeechRecognition;

interface TeacherOption {
  id: string;
  displayName: string;
  color?: string | null;
  priority?: number;
}
type TeacherAvailabilityReason = "absent" | "unavailable" | "booked";
interface FreeSlotSuggestion {
  date: string;
  time: string;
  startsAt: string;
  endsAt: string;
  teacherId: string | null;
  teacherName: string | null;
}
interface TeacherAvailabilityResponse {
  /** ordered best-first: lesson-type teachers, then priority, then stable random */
  data: { teacherId: string; available: boolean; reason: TeacherAvailabilityReason | null; fitsLessonType: boolean }[];
  firstFreeSlot: FreeSlotSuggestion | null;
  /** up to two non-overlapping suggestions on that day, best first */
  freeSlots?: FreeSlotSuggestion[];
}
interface ResourceOption {
  id: string;
  name: string;
  capacity: number;
}
interface LessonTypeOption {
  id: string;
  name: string;
  defaultDurationMin: number | null;
}
interface CustomerOption {
  id: string;
  displayName: string;
  phones?: { e164: string | null; raw: string | null; isPrimary: boolean }[];
}
interface SchedulingOptions {
  teachers: TeacherOption[];
  resources: ResourceOption[];
  lessonTypes: LessonTypeOption[];
  customers: CustomerOption[];
  defaultTeacherId: string | null;
  defaultLessonTypeId: string | null;
  teacherLabel: string;
  resourcesEnabled: boolean;
  businessTimeZone: string;
}
interface AppointmentDto {
  id: string;
  version?: number;
  status?: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  appointmentContactText: string | null;
  appointmentPhoneRaw?: string | null;
  appointmentPhoneE164?: string | null;
  unstructuredNote?: string | null;
  draftReminderAt?: string | null;
  draftReminderText?: string | null;
  teacher: TeacherOption | null;
  teachers?: TeacherOption[] | null;
  resource: ResourceOption | null;
  lessonType: LessonTypeOption | null;
  customer: CustomerOption | null;
}

const props = defineProps<{
  appointment?: AppointmentDto | null;
  initialContactText?: string;
  initialTeacherId?: string;
  initialLessonTypeId?: string;
  /** ISO start for a new appointment, e.g. from a click into the timeline. */
  initialStartsAt?: string;
  startWithVoice?: boolean;
}>();

const emit = defineEmits<{
  saved: [appointment: AppointmentDto];
  cancel: [];
}>();

const { primaryTenant, canPlanAllAppointments } = useAuth();
const { device } = useDeviceCapabilities();
const { t, locale } = useI18n();

const intlLocales: Record<string, string> = { de: "de-DE", en: "en-GB", it: "it-IT" };
const intlLocale = computed(() => intlLocales[locale.value] ?? "de-DE");

const statusOptions: AppointmentStatus[] = ["draft", "confirmed", "completed", "cancelled"];

function statusIsMuted(status: AppointmentStatus) {
  return status === "draft" || status === "completed";
}

function statusButtonColor(status: AppointmentStatus) {
  if (statusIsMuted(status) && form.status !== status) return "neutral" as const;
  return appointmentStatusColor(status);
}

function statusButtonVariant(status: AppointmentStatus): "solid" | "soft" | "outline" {
  if (form.status !== status) return "outline";
  return statusIsMuted(status) ? "soft" : "solid";
}

function statusButtonClass(status: AppointmentStatus) {
  if (form.status === status || !statusIsMuted(status)) return "";
  if (status === "draft") {
    return "hover:border-amber-300 hover:bg-amber-50 hover:text-amber-800 dark:hover:border-amber-700 dark:hover:bg-amber-950/30 dark:hover:text-amber-200";
  }
  return "hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-800 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/30 dark:hover:text-emerald-200";
}

const teacherLabel = computed(
  () => options.value?.teacherLabel || primaryTenant.value?.teacherLabel || t("quickCapture.teacherFallback"),
);
const resourcesEnabled = computed(
  () => options.value?.resourcesEnabled ?? primaryTenant.value?.resourcesEnabled ?? true,
);
const speechRecognitionEnabled = computed(
  () => primaryTenant.value?.speechRecognitionEnabled ?? false,
);

const isEditing = computed(() => Boolean(props.appointment?.id));
const text = ref(props.appointment?.appointmentContactText ?? props.initialContactText ?? "");
const options = ref<SchedulingOptions | null>(null);
const speechLanguage = computed(() => primaryTenant.value?.speechLanguage || "de-DE");
/** Known names for the recognizer: biasing on Android 13+ and choosing between alternatives. */
const speechHints = computed(() => {
  const current = options.value;
  if (!current) return [] as string[];
  return [
    ...current.teachers.map((item) => item.displayName),
    ...current.lessonTypes.map((item) => item.name),
    ...current.resources.map((item) => item.name),
    ...current.customers.map((item) => item.displayName),
  ].filter((name) => Boolean(name && name.trim()));
});
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const conflictType = ref("");
const conflictTeacherId = ref("");
const freeSlots = ref<{ startsAt: string; endsAt: string }[]>([]);
const saved = ref<AppointmentDto | null>(null);
const initialStart = props.initialStartsAt ? new Date(props.initialStartsAt) : nextFullHour();

const speechSupported = ref(false);
const speechListening = ref(false);
const speechInterim = ref("");
const speechError = ref("");
const parseLoading = ref(false);
const parseHint = ref("");
const questions = ref<ClarifyingQuestion[]>([]);
const parseAnswers = reactive<Record<string, string>>({});
const passengerName = ref("");
const callHints = ref<CallHint[]>([]);
const pickingContact = ref(false);
const savingDeviceContact = ref(false);
const removingDeviceContact = ref(false);
const deviceContactHint = ref("");
const STOP_COMMAND_RE =
  /(?:^|\s)(?:bitte\s+)?(?:speichern|fertig|ok(?:ay)?|o\.?\s*k\.?|stopp|stop|ende)(?:\s*[.!,])?\s*$/i;

let recognition: WebSpeechRecognition | null = null;
let speechTextBase = "";
let parseAfterListen = false;
let speechStopping = false;
let speechRestartTimer: ReturnType<typeof setTimeout> | null = null;
let stopNativeSpeech: (() => Promise<void>) | null = null;

function clearSpeechRestart() {
  if (speechRestartTimer == null) return;
  clearTimeout(speechRestartTimer);
  speechRestartTimer = null;
}

function collectSpoken(event: WebSpeechRecognitionEvent): { finalText: string; interimText: string } {
  let finalText = "";
  let interimText = "";
  for (let i = 0; i < event.results.length; i += 1) {
    const result = event.results[i];
    if (!result) continue;
    const alternatives: string[] = [];
    for (let j = 0; j < (result.length || 1); j += 1) {
      const alternative = result[j]?.transcript;
      if (alternative) alternatives.push(alternative);
    }
    const transcript = pickTranscript(alternatives[0] ?? "", alternatives.slice(1), speechHints.value);
    if (!transcript) continue;
    if (result.isFinal) finalText = commitUtterance(finalText, transcript);
    else interimText = transcript;
  }
  return { finalText, interimText };
}

function applySpoken(finalText: string, interimText: string, allowStop = true) {
  const committed = commitUtterance(speechTextBase, finalText);
  const combined = withLiveInterim(committed, interimText);
  const { cleaned, stop } = stripStopCommand(combined);
  text.value = cleaned;
  speechInterim.value = interimText;
  if (!stop || !allowStop) return;
  speechTextBase = cleaned;
  speechInterim.value = "";
  stopListeningWithParse();
}

function stripStopCommand(value: string): { cleaned: string; stop: boolean } {
  const match = STOP_COMMAND_RE.exec(value);
  if (!match) return { cleaned: value.replace(/\s+/g, " ").trim(), stop: false };
  return { cleaned: value.slice(0, match.index).replace(/\s+/g, " ").trim(), stop: true };
}

function stopListeningWithParse() {
  if (speechStopping) return;
  speechStopping = true;
  speechListening.value = false;
  speechInterim.value = "";
  parseAfterListen = true;
  clearSpeechRestart();
  if (stopNativeSpeech) {
    const stop = stopNativeSpeech;
    stopNativeSpeech = null;
    void stop().then(() => {
      parseAfterListen = false;
      speechStopping = false;
      void parseFromText();
    });
    return;
  }
  if (!recognition) {
    parseAfterListen = false;
    speechStopping = false;
    void parseFromText();
    return;
  }
  try {
    recognition.stop();
  } catch {
    parseAfterListen = false;
    speechStopping = false;
    void parseFromText();
  }
}

function getSpeechCtor(): WebSpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: WebSpeechCtor;
    webkitSpeechRecognition?: WebSpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function micDeniedMessage() {
  return device.value.platform === "web" ? t("quickCapture.micDeniedWeb") : t("quickCapture.micDeniedApp");
}

function setupSpeech() {
  if (isNativeAndroidSpeech()) {
    speechSupported.value = true;
  }
  const Ctor = getSpeechCtor();
  if (!Ctor) {
    return;
  }
  speechSupported.value = true;
  recognition = new Ctor();
  recognition.lang = speechLanguage.value;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;
  recognition.onresult = (event) => {
    if (speechStopping) return;
    const { finalText, interimText } = collectSpoken(event);
    applySpoken(finalText, interimText, Boolean(finalText));
  };
  recognition.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    speechError.value =
      event.error === "not-allowed"
        ? micDeniedMessage()
        : event.message || event.error || t("quickCapture.speechFailed");
  };
  recognition.onend = () => {
    speechInterim.value = "";
    const shouldParse = parseAfterListen;
    parseAfterListen = false;
    if (speechStopping || shouldParse) {
      speechStopping = false;
      speechListening.value = false;
      if (shouldParse) void parseFromText();
      return;
    }
    if (speechListening.value && recognition) {
      speechTextBase = text.value.trim();
      speechRestartTimer = setTimeout(() => {
        speechRestartTimer = null;
        if (!speechListening.value || speechStopping || !recognition) return;
        try {
          recognition.start();
        } catch {
          speechListening.value = false;
        }
      }, 200);
      return;
    }
    speechListening.value = false;
    speechStopping = false;
  };
}

async function toggleSpeech() {
  if (!speechRecognitionEnabled.value) return;
  speechError.value = "";
  if (speechListening.value) {
    speechListening.value = false;
    clearSpeechRestart();
    if (stopNativeSpeech) {
      const stop = stopNativeSpeech;
      stopNativeSpeech = null;
      await stop();
      return;
    }
    recognition?.stop();
    return;
  }
  const micOk = await device.value.requestMicrophonePermission();
  if (!micOk) {
    speechError.value = micDeniedMessage();
    return;
  }
  speechTextBase = text.value.trim();
  speechInterim.value = "";
  speechStopping = false;
  clearSpeechRestart();
  if (recognition) recognition.lang = speechLanguage.value;
  if (isNativeAndroidSpeech()) {
    try {
      stopNativeSpeech = await startNativeSpeech({
        onTranscript: (transcript, isFinal) => {
          if (speechStopping) return;
          if (isFinal) {
            applySpoken(transcript, "", true);
            if (speechListening.value) speechTextBase = text.value.trim();
            return;
          }
          applySpoken("", transcript, false);
        },
        onSessionEnd: () => {
          if (speechStopping) return;
          speechTextBase = text.value.trim();
          speechInterim.value = "";
        },
        onError: (message) => {
          speechError.value = message;
        },
      }, { lang: speechLanguage.value, hints: speechHints.value });
      speechListening.value = true;
    } catch (e) {
      stopNativeSpeech = null;
      if (recognition) {
        try {
          recognition.start();
          speechListening.value = true;
          return;
        } catch {
          // Fall through to the error below.
        }
      }
      const err = e as { message?: string };
      speechError.value = err.message || t("quickCapture.speechStartFailed");
      speechListening.value = false;
    }
    return;
  }
  if (!recognition) return;
  try {
    recognition.start();
    speechListening.value = true;
  } catch (e) {
    const err = e as { message?: string };
    speechError.value = err.message || t("quickCapture.speechStartFailed");
    speechListening.value = false;
  }
}

function toggleVoiceAssistant() {
  if (!speechRecognitionEnabled.value) {
    void parseFromText();
    return;
  }
  speechError.value = "";
  parseHint.value = "";
  if (!speechSupported.value && !recognition) {
    void parseFromText();
    return;
  }
  if (speechListening.value) {
    stopListeningWithParse();
    return;
  }
  Object.keys(parseAnswers).forEach((key) => delete parseAnswers[key]);
  void toggleSpeech();
}

function applyParsed(
  parsed: ParsedAppointmentIntent,
  suggested?: Record<string, unknown>,
) {
  if (parsed.contactText) text.value = parsed.contactText;
  const slotSuggested = suggested?.slotSource === "priority";
  if (parsed.date && (!isEditing.value || !slotSuggested)) form.date = parsed.date;
  if (parsed.time && (!isEditing.value || !slotSuggested)) form.time = parsed.time;
  if (parsed.durationMinutes) form.durationMinutes = parsed.durationMinutes;
  if (
    canPlanAllAppointments.value &&
    parsed.teacherId &&
    (!isEditing.value || !slotSuggested || !form.teacherIds.length)
  ) {
    setTeacherIds([parsed.teacherId], true);
  }
  if (parsed.resourceId) form.resourceId = parsed.resourceId;
  if (parsed.lessonTypeId) form.lessonTypeId = parsed.lessonTypeId;
  if (parsed.phone) form.phone = parsed.phone;
  if (parsed.note) form.note = parsed.note;
  if (parsed.customerId) {
    form.customerId = parsed.customerId;
    const known = options.value?.customers.find((item) => item.id === parsed.customerId);
    passengerName.value = parsed.customerName || known?.displayName || passengerName.value;
    if (parsed.customerName && options.value && !known) {
      options.value.customers = [
        ...options.value.customers,
        { id: parsed.customerId, displayName: parsed.customerName },
      ];
    }
  } else if (parsed.customerName) {
    form.customerId = "";
    passengerName.value = parsed.customerName;
  } else {
    form.customerId = "";
    passengerName.value = "";
  }
}

async function parseFromText() {
  if (!primaryTenant.value || !text.value.trim()) return;
  parseLoading.value = true;
  parseHint.value = "";
  error.value = "";
  try {
    const result = await $fetch<ParseIntentResponse>(
      `/api/v1/tenants/${primaryTenant.value.tenantId}/assistant/parse-intent`,
      {
        method: "POST",
        credentials: "include",
        body: { text: text.value, answers: { ...parseAnswers } },
      },
    );
    applyParsed(result.parsed, result.suggestedDefaults);
    questions.value = result.clarifyingQuestions ?? [];
    const passenger = result.parsed.customerName;
    const slot = result.suggestedDefaults;
    const slotHint = (() => {
      if (isEditing.value || slot?.slotSource !== "priority" || typeof slot.date !== "string" || typeof slot.time !== "string") {
        return "";
      }
      const when = new Intl.DateTimeFormat(intlLocale.value, {
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(`${slot.date}T${slot.time}`));
      const who = typeof slot.teacherName === "string" && slot.teacherName ? ` · ${slot.teacherName}` : "";
      return ` ${t("quickCapture.parseNextSlot", { priority: Number(slot.priority) || 0, when, who })}`;
    })();
    parseHint.value = questions.value.length
      ? t("quickCapture.parseClarify")
      : passenger
        ? result.parsed.customerId
          ? `${t("quickCapture.parseFound", { name: passenger })}${slotHint}`
          : `${t("quickCapture.parseNewCustomer", { name: passenger })}${slotHint}`
        : `${t("quickCapture.parseNoCustomer")}${slotHint}`;
  } catch (e: unknown) {
    error.value = apiErrorMessage(e);
  } finally {
    parseLoading.value = false;
  }
}

function answerQuestion(questionId: string, value: string) {
  parseAnswers[questionId] = value;
  void parseFromText();
}

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onCallHintsVisible);
  window.removeEventListener(CALL_STATE_EVENT, onCallStateChanged);
  if (availabilityTimer) clearTimeout(availabilityTimer);
  speechListening.value = false;
  speechStopping = true;
  clearSpeechRestart();
  if (stopNativeSpeech) {
    const stop = stopNativeSpeech;
    stopNativeSpeech = null;
    void stop();
  }
  if (recognition) {
    try {
      recognition.abort();
    } catch {
      // ignore
    }
  }
});

function assignedTeacherIds(appointment?: AppointmentDto | null, fallbackId?: string) {
  const fromList = appointment?.teachers?.map((item) => item.id).filter(Boolean) ?? [];
  if (fromList.length) return fromList;
  if (appointment?.teacher?.id) return [appointment.teacher.id];
  if (fallbackId) return [fallbackId];
  return [];
}

const form = reactive({
  date: toDateInput(props.appointment ? new Date(props.appointment.startsAt) : initialStart),
  time: toTimeInput(props.appointment ? new Date(props.appointment.startsAt) : initialStart),
  durationMinutes: props.appointment
    ? durationMinutesFromRange(props.appointment.startsAt, props.appointment.endsAt)
    : 60,
  teacherIds: assignedTeacherIds(props.appointment, props.initialTeacherId),
  resourceId: props.appointment?.resource?.id ?? "",
  lessonTypeId: props.appointment?.lessonType?.id ?? props.initialLessonTypeId ?? "",
  customerId: props.appointment?.customer?.id ?? "",
  phone: props.appointment ? resolveAppointmentPhone(props.appointment) ?? "" : "",
  note: props.appointment?.unstructuredNote ?? "",
  status: (props.appointment?.status ?? "confirmed") as AppointmentStatus,
  reminderText: props.appointment?.draftReminderText ?? "",
  reminderDate: props.appointment?.draftReminderAt ? toDateInput(new Date(props.appointment.draftReminderAt)) : "",
  reminderTime: props.appointment?.draftReminderAt ? toTimeInput(new Date(props.appointment.draftReminderAt)) : "",
});
const isDraft = computed({
  get: () => form.status === "draft",
  set: (value: boolean) => {
    form.status = value ? "draft" : "confirmed";
  },
});
let hydratingForm = false;

const colleagueNames = computed(() => {
  const mine = primaryTenant.value?.teacherProfileId;
  const list = props.appointment?.teachers?.length
    ? props.appointment.teachers
    : props.appointment?.teacher
      ? [props.appointment.teacher]
      : [];
  return list
    .filter((item) => item.id && item.id !== mine)
    .map((item) => item.displayName)
    .filter(Boolean)
    .join(", ");
});

if (props.appointment?.customer?.displayName || props.appointment?.appointmentContactText) {
  passengerName.value = props.appointment.customer?.displayName ?? props.appointment.appointmentContactText ?? "";
}

const durationOptions = [30, 45, 60, 90, 120];
const useTypeDuration = computed(() => primaryTenant.value?.useDefaultDuration ?? true);
const CUSTOMER_SUGGEST_MIN_LEN = 3;

const customerSuggestions = computed(() => {
  const query = passengerName.value.trim();
  if (query.length < CUSTOMER_SUGGEST_MIN_LEN) return [];
  const q = query.toLowerCase();
  return (options.value?.customers ?? [])
    .filter((customer) => customer.displayName.toLowerCase().includes(q))
    .slice(0, 8);
});

const showCustomerSuggestions = computed(() => {
  const query = passengerName.value.trim();
  if (query.length < CUSTOMER_SUGGEST_MIN_LEN || !customerSuggestions.value.length) return false;
  const selected = form.customerId
    ? options.value?.customers.find((item) => item.id === form.customerId)
    : null;
  if (selected && selected.displayName === query) return false;
  return true;
});

const willCreateCustomer = computed(
  () => Boolean(passengerName.value.trim().length >= 2) && !form.customerId,
);

function pickCustomerSuggestion(customer: CustomerOption) {
  form.customerId = customer.id;
  passengerName.value = customer.displayName;
}
const canPickContact = computed(() => device.value.features.pickContact);
const { lookup: deviceContactLookup, checking: checkingDeviceContact, canDelete: canDeleteDeviceContactFeature, savedOnDevice, refresh: refreshDeviceContact } =
  useDeviceContactLookup(() => form.phone);
const canSaveDeviceContact = computed(
  () =>
    device.value.features.saveContact &&
    Boolean(form.phone.trim()) &&
    Boolean(passengerName.value.trim() || text.value.trim()) &&
    !savedOnDevice.value,
);
const canRemoveDeviceContact = computed(
  () =>
    canDeleteDeviceContactFeature.value && savedOnDevice.value && Boolean(form.phone.trim()),
);
const canManageDeviceContact = computed(
  () =>
    canSaveDeviceContact.value ||
    canRemoveDeviceContact.value ||
    Boolean(deviceContactHint.value) ||
    (checkingDeviceContact.value && Boolean(form.phone.trim())),
);
const deviceContactStatusLabel = computed(() => {
  if (deviceContactHint.value) return "";
  if (!savedOnDevice.value) return "";
  const match = deviceContactLookup.value.match;
  const name = match?.displayName?.trim();
  if (name) {
    return match?.googleSynced
      ? t("quickCapture.contactInGoogleAs", { name })
      : t("quickCapture.contactOnPhoneAs", { name });
  }
  return match?.googleSynced ? t("quickCapture.contactInGoogle") : t("quickCapture.contactOnPhone");
});
const showCallHintsOptInHint = computed(
  () => device.value.features.callHints && !isCallHintsOptIn() && !callHints.value.length,
);

function applyCallHint(hint: CallHint) {
  const phone = hint.e164 || hint.raw;
  if (phone) form.phone = phone;
}

function formatCallHintTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocale.value, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function loadCallHints() {
  if (!device.value.features.callHints || !isCallHintsOptIn()) {
    callHints.value = [];
    return;
  }
  try {
    callHints.value = await device.value.getRecentCallHints(2);
  } catch {
    callHints.value = [];
  }
}

function onCallHintsVisible() {
  if (document.visibilityState === "visible") void loadCallHints();
}

function onCallStateChanged() {
  void loadCallHints();
}

async function pickDeviceContact() {
  pickingContact.value = true;
  deviceContactHint.value = "";
  try {
    const contact = await device.value.pickContact();
    if (!contact) return;
    if (contact.phone) form.phone = contact.phone;
    if (contact.name && !passengerName.value.trim()) {
      passengerName.value = contact.name;
    }
    await refreshDeviceContact();
  } catch {
    deviceContactHint.value = t("quickCapture.contactReadFailed");
  } finally {
    pickingContact.value = false;
  }
}

async function saveDeviceContact() {
  if (!canSaveDeviceContact.value) return;
  savingDeviceContact.value = true;
  deviceContactHint.value = "";
  try {
    const organization = resolveContactOrganization(primaryTenant.value?.tenantName);
    await device.value.saveOrUpdateDeviceContact({
      displayName:
        passengerName.value.trim() ||
        text.value.trim() ||
        fallbackContactDisplayName(primaryTenant.value?.tenantName),
      phoneE164: form.phone.trim() || undefined,
      organization,
    });
    await refreshDeviceContact();
    const match = deviceContactLookup.value.match;
    if (device.value.platform === "web") {
      deviceContactHint.value = t("quickCapture.contactVcardDownloaded", { organization });
    } else if (deviceContactLookup.value.status === "missing") {
      deviceContactHint.value = t("quickCapture.contactNotFoundAfterSave");
    } else if (match?.googleSynced) {
      deviceContactHint.value = match.displayName
        ? t("quickCapture.contactInGoogleAs", { name: match.displayName })
        : t("quickCapture.contactAlreadyInGoogle");
    } else if (match?.displayName) {
      deviceContactHint.value = t("quickCapture.contactOnPhoneAs", { name: match.displayName });
    } else {
      deviceContactHint.value = t("quickCapture.contactSavedLocally", { organization });
    }
  } catch {
    deviceContactHint.value = t("quickCapture.contactSaveFailed");
  } finally {
    savingDeviceContact.value = false;
  }
}

async function removeDeviceContact() {
  if (!canRemoveDeviceContact.value) return;
  const google = deviceContactLookup.value.match?.googleSynced;
  const ok = window.confirm(
    google ? t("quickCapture.contactDeleteConfirmGoogle") : t("quickCapture.contactDeleteConfirm"),
  );
  if (!ok) return;
  removingDeviceContact.value = true;
  deviceContactHint.value = "";
  try {
    await device.value.deleteDeviceContact(form.phone.trim());
    await refreshDeviceContact();
    deviceContactHint.value = t("quickCapture.contactRemoved");
  } catch {
    deviceContactHint.value = t("quickCapture.contactRemoveFailed");
  } finally {
    removingDeviceContact.value = false;
  }
}

watch(passengerName, (name) => {
  if (hydratingForm || isEditing.value) return;
  const selected = options.value?.customers.find((item) => item.id === form.customerId);
  if (!selected) return;
  if (name.trim() !== selected.displayName) {
    form.customerId = "";
  }
});

const selectedLessonType = computed(() =>
  options.value?.lessonTypes.find((item) => item.id === form.lessonTypeId) ?? null,
);

const effectiveDuration = computed(() => form.durationMinutes || selectedLessonType.value?.defaultDurationMin || 60);

const endTime = computed({
  get: () => {
    if (!form.date || !form.time) return "";
    const startsAt = localDateTime(form.date, form.time);
    return toTimeInput(new Date(startsAt.getTime() + effectiveDuration.value * 60_000));
  },
  set: (value: string) => {
    if (!value || !form.time) return;
    let minutes = minutesOfDay(value) - minutesOfDay(form.time);
    if (minutes <= 0) minutes += 24 * 60;
    form.durationMinutes = minutes;
  },
});

const teacherAvailability = ref<Record<string, TeacherAvailabilityResponse["data"][number]>>({});
const teacherRanking = ref<string[]>([]);
const suggestedSlots = ref<FreeSlotSuggestion[]>([]);
const availabilityLoading = ref(false);
const teacherTouched = ref(isEditing.value || Boolean(props.initialTeacherId));
let assigningTeachers = false;
let availabilityRequest = 0;
let availabilityTimer: ReturnType<typeof setTimeout> | null = null;

function setTeacherIds(ids: string[], touched: boolean) {
  assigningTeachers = true;
  form.teacherIds = ids;
  if (touched) teacherTouched.value = true;
  assigningTeachers = false;
}

watch(
  () => [...form.teacherIds],
  () => {
    if (assigningTeachers || hydratingForm) return;
    teacherTouched.value = true;
    teacherReplacedHint.value = "";
  },
  { flush: "sync" },
);

const hasAvailability = computed(() => Object.keys(teacherAvailability.value).length > 0);

function teacherIsAvailable(id: string) {
  return !hasAvailability.value || teacherAvailability.value[id]?.available !== false;
}

function teacherRank(id: string) {
  const index = teacherRanking.value.indexOf(id);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

const pickerTeachers = computed(() =>
  (options.value?.teachers ?? [])
    .filter((teacher) => teacherIsAvailable(teacher.id) || form.teacherIds.includes(teacher.id))
    .sort((left, right) => teacherRank(left.id) - teacherRank(right.id)),
);

const teacherHints = computed(() => {
  const hints: Record<string, string> = {};
  for (const id of form.teacherIds) {
    const reason = teacherAvailability.value[id]?.reason;
    if (reason) hints[id] = t(`quickCapture.availability.${reason}`);
  }
  return hints;
});

const unavailableSelectedLabel = computed(() =>
  form.teacherIds
    .filter((id) => teacherHints.value[id])
    .map((id) => {
      const name = options.value?.teachers.find((teacher) => teacher.id === id)?.displayName ?? teacherLabel.value;
      return `${name} ${teacherHints.value[id]}`;
    })
    .join(", "),
);

const noTeacherAvailable = computed(
  () => hasAvailability.value && !(options.value?.teachers ?? []).some((teacher) => teacherIsAvailable(teacher.id)),
);

function slotIsSelected(slot: FreeSlotSuggestion) {
  return slot.time === form.time && (!slot.teacherId || form.teacherIds.includes(slot.teacherId));
}

const visibleSuggestedSlots = computed(() => {
  const slots = suggestedSlots.value.filter((slot) => slot.date === form.date);
  return slots.every(slotIsSelected) ? [] : slots;
});

const teacherReplacedHint = ref("");
let availabilityChecks = 0;

function teacherName(id: string) {
  return options.value?.teachers.find((teacher) => teacher.id === id)?.displayName ?? teacherLabel.value;
}

function teacherFitsRules(id: string) {
  const typeRestricted = Object.values(teacherAvailability.value).some((item) => item.fitsLessonType);
  return teacherIsAvailable(id) && (!typeRestricted || teacherAvailability.value[id]?.fitsLessonType === true);
}

function nextTeacherCandidate(exclude: string[]) {
  const own = primaryTenant.value?.teacherProfileId;
  if (own && !exclude.includes(own) && teacherAvailability.value[own] && teacherFitsRules(own)) return own;
  return teacherRanking.value.find((id) => !exclude.includes(id) && teacherIsAvailable(id)) ?? null;
}

function autoAssignTeacher() {
  const firstCheck = availabilityChecks === 0;
  availabilityChecks += 1;
  if (!canPlanAllAppointments.value || !hasAvailability.value) return;

  if (!isEditing.value && !teacherTouched.value) {
    teacherReplacedHint.value = "";
    const best = nextTeacherCandidate([]);
    setTeacherIds(best ? [best] : [], false);
    return;
  }

  if (isEditing.value && firstCheck) return;
  const replaced: string[] = [];
  const next: string[] = [];
  for (const id of form.teacherIds) {
    if (teacherIsAvailable(id)) {
      next.push(id);
      continue;
    }
    const substitute = nextTeacherCandidate([...form.teacherIds, ...next]);
    if (!substitute) {
      next.push(id);
      continue;
    }
    next.push(substitute);
    const reason = teacherAvailability.value[id]?.reason;
    replaced.push(
      t("quickCapture.teacherReplaced", {
        from: teacherName(id),
        reason: reason ? t(`quickCapture.availability.${reason}`) : "",
        to: teacherName(substitute),
      }),
    );
  }
  if (!replaced.length) return;
  setTeacherIds(next, false);
  teacherReplacedHint.value = replaced.join(" ");
}

async function loadAvailability() {
  if (!primaryTenant.value || !options.value || !form.date || !form.time) return;
  const startsAt = localDateTime(form.date, form.time);
  if (Number.isNaN(startsAt.getTime())) return;
  const endsAt = new Date(startsAt.getTime() + effectiveDuration.value * 60_000);
  const requestId = ++availabilityRequest;
  availabilityLoading.value = true;
  try {
    const result = await $fetch<TeacherAvailabilityResponse>(
      `/api/v1/tenants/${primaryTenant.value.tenantId}/scheduling/availability`,
      {
        credentials: "include",
        query: {
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          excludeAppointmentId: props.appointment?.id || undefined,
          resourceId: resourcesEnabled.value ? form.resourceId || undefined : undefined,
          lessonTypeId: form.lessonTypeId || undefined,
        },
      },
    );
    if (requestId !== availabilityRequest) return;
    teacherAvailability.value = Object.fromEntries(result.data.map((item) => [item.teacherId, item]));
    teacherRanking.value = result.data.map((item) => item.teacherId);
    suggestedSlots.value = result.freeSlots ?? (result.firstFreeSlot ? [result.firstFreeSlot] : []);
    autoAssignTeacher();
  } catch {
    if (requestId !== availabilityRequest) return;
    teacherAvailability.value = {};
    teacherRanking.value = [];
    suggestedSlots.value = [];
  } finally {
    if (requestId === availabilityRequest) availabilityLoading.value = false;
  }
}

function scheduleAvailability() {
  if (availabilityTimer) clearTimeout(availabilityTimer);
  availabilityTimer = setTimeout(() => {
    availabilityTimer = null;
    void loadAvailability();
  }, 250);
}

watch(
  () => [form.date, form.time, effectiveDuration.value, form.resourceId, form.lessonTypeId, options.value],
  scheduleAvailability,
);

function applySuggestedSlot(slot: FreeSlotSuggestion) {
  form.date = slot.date;
  form.time = slot.time;
  if (slot.teacherId && canPlanAllAppointments.value && !form.teacherIds.includes(slot.teacherId)) {
    setTeacherIds([slot.teacherId], true);
  }
}

const captureSelectClass =
  "w-full min-h-10 rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-3 py-2.5 text-sm";
const captureInputUi = { base: "min-h-10 py-2.5" };

const canSave = computed(() =>
  Boolean(primaryTenant.value && form.date && form.time && (text.value.trim() || passengerName.value.trim() || form.customerId)),
);

function durationMinutesFromRange(startsAt: string, endsAt: string) {
  const minutes = Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000);
  return minutes > 0 ? minutes : 60;
}

function fillFromAppointment(appointment: AppointmentDto) {
  hydratingForm = true;
  const startsAt = new Date(appointment.startsAt);
  text.value = appointment.appointmentContactText ?? "";
  form.date = toDateInput(startsAt);
  form.time = toTimeInput(startsAt);
  form.durationMinutes = durationMinutesFromRange(appointment.startsAt, appointment.endsAt);
  form.teacherIds = assignedTeacherIds(appointment);
  form.resourceId = appointment.resource?.id ?? "";
  form.lessonTypeId = appointment.lessonType?.id ?? "";
  form.customerId = appointment.customer?.id ?? "";
  form.phone = resolveAppointmentPhone(appointment) ?? "";
  form.note = appointment.unstructuredNote ?? "";
  form.status = appointment.status ?? "confirmed";
  const reminderAt = appointment.draftReminderAt ? new Date(appointment.draftReminderAt) : null;
  form.reminderText = appointment.draftReminderText ?? "";
  form.reminderDate = reminderAt ? toDateInput(reminderAt) : "";
  form.reminderTime = reminderAt ? toTimeInput(reminderAt) : "";
  passengerName.value = appointment.customer?.displayName ?? appointment.appointmentContactText ?? "";
  hydratingForm = false;
}

function nextFullHour() {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function toDateInput(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInput(date: Date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function minutesOfDay(timeValue: string) {
  const [hour, minute] = timeValue.split(":").map(Number);
  return hour * 60 + minute;
}

function localDateTime(dateValue: string, timeValue: string) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(intlLocale.value, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function apiErrorMessage(e: unknown) {
  const err = e as {
    data?: { message?: string; statusMessage?: string; data?: { message?: string; details?: Record<string, unknown> } };
    statusMessage?: string;
  };
  const details = err.data?.data?.details;
  conflictType.value = typeof details?.conflictType === "string" ? details.conflictType : "";
  conflictTeacherId.value = typeof details?.teacherId === "string" ? details.teacherId : "";
  freeSlots.value = Array.isArray(details?.freeSlots)
    ? (details.freeSlots as { startsAt: string; endsAt: string }[])
    : [];
  return (
    err.data?.data?.message ||
    err.data?.message ||
    err.data?.statusMessage ||
    err.statusMessage ||
    t("quickCapture.actionFailed")
  );
}

async function loadOptions() {
  if (!primaryTenant.value) return;
  loading.value = true;
  error.value = "";
  try {
    options.value = await $fetch<SchedulingOptions>(
      `/api/v1/tenants/${primaryTenant.value.tenantId}/scheduling/options`,
      { credentials: "include" },
    );
    if (props.appointment) {
      fillFromAppointment(props.appointment);
    } else {
      if (!form.teacherIds.length) {
        const preferred = options.value.defaultTeacherId;
        const fallback =
          preferred && options.value.teachers.some((teacher) => teacher.id === preferred)
            ? preferred
            : (options.value.teachers[0]?.id ?? "");
        if (fallback) setTeacherIds([fallback], false);
      }
      if (resourcesEnabled.value) {
        form.resourceId ||= options.value.resources[0]?.id ?? "";
      } else {
        form.resourceId = "";
      }
      if (!form.lessonTypeId) {
        const preferred = options.value.defaultLessonTypeId;
        form.lessonTypeId =
          preferred && options.value.lessonTypes.some((lessonType) => lessonType.id === preferred)
            ? preferred
            : (options.value.lessonTypes[0]?.id ?? "");
      }
      const selectedType = options.value.lessonTypes.find((item) => item.id === form.lessonTypeId);
      if (selectedType?.defaultDurationMin) {
        form.durationMinutes = selectedType.defaultDurationMin;
      }
    }
  } catch (e: unknown) {
    error.value = apiErrorMessage(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => form.lessonTypeId,
  (lessonTypeId) => {
    if (hydratingForm) return;
    const lessonType = options.value?.lessonTypes.find((item) => item.id === lessonTypeId);
    if (lessonType?.defaultDurationMin) {
      form.durationMinutes = lessonType.defaultDurationMin;
    }
  },
);

watch(
  () => primaryTenant.value?.tenantId,
  () => {
    loadOptions();
  },
);

const conflictTeacherName = computed(
  () => options.value?.teachers.find((teacher) => teacher.id === conflictTeacherId.value)?.displayName ?? "",
);

function formatSlotTime(value: string) {
  return toTimeInput(new Date(value));
}

function applyFreeSlot(slot: { startsAt: string }) {
  const startsAt = new Date(slot.startsAt);
  form.date = toDateInput(startsAt);
  form.time = toTimeInput(startsAt);
  error.value = "";
  conflictType.value = "";
  freeSlots.value = [];
}

async function saveAppointment() {
  if (!primaryTenant.value || !canSave.value) return;

  const startsAt = localDateTime(form.date, form.time);
  const endsAt = new Date(startsAt.getTime() + effectiveDuration.value * 60_000);
  saving.value = true;
  error.value = "";
  conflictType.value = "";
  freeSlots.value = [];
  saved.value = null;

  try {
    let customerId = form.customerId || undefined;
    if (!customerId && passengerName.value.trim().length >= 2) {
      const created = await $fetch<{ id: string; displayName: string }>(
        `/api/v1/tenants/${primaryTenant.value.tenantId}/customers`,
        {
          method: "POST",
          credentials: "include",
          body: {
            displayName: passengerName.value.trim(),
            customerSource: "from_appointment",
            phones: form.phone
              ? [{ e164: form.phone, raw: form.phone, isPrimary: true }]
              : [],
          },
        },
      );
      customerId = created.id;
      if (options.value && !options.value.customers.some((item) => item.id === created.id)) {
        options.value.customers = [
          ...options.value.customers,
          { id: created.id, displayName: created.displayName },
        ];
      }
      form.customerId = created.id;
      passengerName.value = created.displayName;
    }

    const phoneValue = form.phone.trim();
    const payload: Record<string, unknown> = {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      lessonTypeId: form.lessonTypeId || null,
      resourceId: resourcesEnabled.value ? form.resourceId || null : undefined,
      customerId: customerId || null,
      customerName: passengerName.value.trim() || undefined,
      appointmentContactText: text.value,
      appointmentPhoneRaw: phoneValue || null,
      appointmentPhoneE164: phoneValue.startsWith("+") ? phoneValue : null,
      unstructuredNote: form.note.trim() || null,
    };
    if (canPlanAllAppointments.value || !isEditing.value) {
      payload.teacherIds = form.teacherIds;
      payload.teacherId = form.teacherIds[0] ?? null;
    }
    if (isEditing.value && form.status !== props.appointment?.status) {
      payload.status = form.status;
    }
    const reminderAt =
      form.status === "draft" && form.reminderDate
        ? localDateTime(form.reminderDate, form.reminderTime || "09:00")
        : null;
    payload.draftReminderAt = reminderAt ? reminderAt.toISOString() : null;
    payload.draftReminderText = reminderAt ? form.reminderText.trim() || null : null;

    const result = isEditing.value
      ? await $fetch<AppointmentDto>(
          `/api/v1/tenants/${primaryTenant.value.tenantId}/appointments/${props.appointment!.id}`,
          {
            method: "PATCH",
            credentials: "include",
            body: payload,
            headers: props.appointment?.version ? { "If-Match": String(props.appointment.version) } : undefined,
          },
        )
      : await $fetch<AppointmentDto>(`/api/v1/tenants/${primaryTenant.value.tenantId}/appointments`, {
          method: "POST",
          credentials: "include",
          body: {
            ...payload,
            status: form.status,
            lessonTypeId: payload.lessonTypeId || undefined,
            teacherId: payload.teacherId || undefined,
            teacherIds: payload.teacherIds,
            resourceId: payload.resourceId || undefined,
            customerId: payload.customerId || undefined,
            appointmentPhoneRaw: payload.appointmentPhoneRaw || undefined,
            appointmentPhoneE164: payload.appointmentPhoneE164 || undefined,
            unstructuredNote: payload.unstructuredNote || undefined,
          },
        });
    saved.value = result;
    emit("saved", result);
  } catch (e: unknown) {
    error.value = apiErrorMessage(e);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  if (speechRecognitionEnabled.value) {
    setupSpeech();
  }
  loadOptions();
  void loadCallHints();
  document.addEventListener("visibilitychange", onCallHintsVisible);
  window.addEventListener(CALL_STATE_EVENT, onCallStateChanged);
  if (speechRecognitionEnabled.value && props.startWithVoice) {
    window.setTimeout(() => toggleVoiceAssistant(), 250);
  }
});
</script>

<template>
  <div class="space-y-4 sm:space-y-5">
    <UAlert
      v-if="!primaryTenant"
      color="warning"
      variant="soft"
      :title="t('quickCapture.noTenantTitle')"
      :description="t('quickCapture.noTenantDescription')"
    />

    <UAlert
      v-if="saved"
      color="success"
      variant="soft"
      icon="i-lucide-circle-check"
      :title="isEditing ? t('quickCapture.updated') : t('quickCapture.saved')"
      :description="`${formatDateTime(saved.startsAt)} · ${saved.appointmentContactText || t('quickCapture.withoutContactText')}`"
    />

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      icon="i-lucide-circle-alert"
      :title="isEditing ? t('quickCapture.updateFailed') : t('quickCapture.saveFailed')"
      :description="conflictType ? `${error} (${conflictType})` : error"
    >
      <template v-if="conflictType === 'TIME_OVERLAP'" #actions>
        <div class="w-full space-y-1.5">
          <p v-if="freeSlots.length" class="text-xs text-neutral-700 dark:text-neutral-300">
            {{ t("quickCapture.conflictFreeSlots", { teacher: conflictTeacherName || teacherLabel }) }}
          </p>
          <p v-else class="text-xs text-neutral-700 dark:text-neutral-300">
            {{ t("quickCapture.conflictNoSlots", { teacher: conflictTeacherName || teacherLabel }) }}
          </p>
          <div v-if="freeSlots.length" class="flex flex-wrap gap-1.5">
            <UButton
              v-for="slot in freeSlots"
              :key="slot.startsAt"
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-clock"
              class="tabular-nums"
              @click="applyFreeSlot(slot)"
            >
              {{ formatSlotTime(slot.startsAt) }}–{{ formatSlotTime(slot.endsAt) }}
            </UButton>
          </div>
        </div>
      </template>
    </UAlert>

    <UFormField :label="t('quickCapture.customer')" class="w-full">
      <div class="relative">
        <UInput
          v-model="passengerName"
          size="md"
          class="w-full"
          :ui="captureInputUi"
          :placeholder="t('quickCapture.customerPlaceholder')"
          autocomplete="off"
        />
        <ul
          v-if="showCustomerSuggestions"
          class="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-neutral-200 bg-white py-1 shadow-md dark:border-neutral-700 dark:bg-neutral-900"
        >
          <li v-for="customer in customerSuggestions" :key="customer.id">
            <button
              type="button"
              class="w-full px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
              @mousedown.prevent="pickCustomerSuggestion(customer)"
            >
              {{ customer.displayName }}
            </button>
          </li>
        </ul>
      </div>
      <p v-if="willCreateCustomer" class="mt-1.5 flex items-center gap-1 text-xs text-neutral-500">
        {{ t("quickCapture.newCustomer", { name: passengerName }) }}
        <FieldInfoPopover :aria-label="t('quickCapture.newCustomerAria')">
          {{ t("quickCapture.newCustomerInfo") }}
        </FieldInfoPopover>
      </p>
    </UFormField>

    <UFormField required>
      <template #label>
        <span class="inline-flex items-center gap-1">
          {{ t("quickCapture.contactOrNote") }}
          <FieldInfoPopover
            v-if="speechRecognitionEnabled && speechSupported"
            :aria-label="t('quickCapture.dictationAria')"
          >
            {{ t("quickCapture.dictationInfo") }}
          </FieldInfoPopover>
        </span>
      </template>
      <div class="relative">
        <UTextarea
          v-model="text"
          autoresize
          :rows="3"
          :placeholder="t('quickCapture.textPlaceholder', { teacher: teacherLabel })"
          class="w-full min-h-[5.5rem] py-2.5 pr-12"
        />
        <UButton
          v-if="speechRecognitionEnabled && speechSupported"
          type="button"
          size="sm"
          :color="speechListening ? 'error' : 'neutral'"
          :variant="speechListening ? 'solid' : 'ghost'"
          :icon="speechListening ? 'i-lucide-mic-off' : 'i-lucide-mic'"
          :title="speechListening ? t('quickCapture.stopRecording') : t('quickCapture.startRecording')"
          class="absolute top-1 right-1"
          @click="toggleSpeech"
        />
      </div>
      <template v-if="speechListening" #help>
        <span class="flex items-center gap-2 text-xs text-primary-700 dark:text-primary-300">
          <span class="inline-block size-2 rounded-full bg-red-500 animate-pulse" />
          {{ t("quickCapture.recording") }}
          <span v-if="speechInterim" class="italic text-neutral-500 truncate">„{{ speechInterim }}"</span>
        </span>
      </template>
    </UFormField>

    <div class="flex flex-wrap items-center gap-1.5">
      <UButton
        v-if="speechRecognitionEnabled"
        type="button"
        size="sm"
        :color="speechListening ? 'error' : 'neutral'"
        :variant="speechListening ? 'solid' : 'soft'"
        :icon="speechListening ? 'i-lucide-mic-off' : 'i-lucide-mic'"
        :loading="parseLoading"
        @click="toggleVoiceAssistant"
      >
        {{ speechListening ? t("quickCapture.stop") : t("quickCapture.voiceAssistant") }}
      </UButton>
      <UButton
        type="button"
        size="sm"
        variant="ghost"
        color="neutral"
        icon="i-lucide-sparkles"
        :loading="parseLoading"
        :disabled="!text.trim()"
        @click="parseFromText"
      >
        {{ t("quickCapture.parseText") }}
      </UButton>
      <FieldInfoPopover :aria-label="t('quickCapture.assistantHintsAria')">
        <p>
          {{ speechRecognitionEnabled ? t("quickCapture.exampleVoice") : t("quickCapture.exampleText") }}
        </p>
        <p v-if="speechRecognitionEnabled" class="mt-2">
          {{ t("quickCapture.stopHint") }}
        </p>
        <p class="mt-2">
          {{ t("quickCapture.priorityHint") }}
        </p>
      </FieldInfoPopover>
      <span
        v-if="speechRecognitionEnabled && !speechSupported"
        class="inline-flex items-center gap-1 text-xs text-neutral-500"
      >
        {{ t("quickCapture.speechUnavailable") }}
        <FieldInfoPopover :aria-label="t('quickCapture.speechUnavailableAria')">
          {{ t("quickCapture.speechUnavailableInfo") }}
        </FieldInfoPopover>
      </span>
    </div>

    <p v-if="parseHint" class="text-sm text-neutral-600 dark:text-neutral-400">
      {{ parseHint }}
    </p>

    <div v-if="questions.length" class="space-y-2">
      <div v-for="question in questions" :key="question.id" class="space-y-1.5">
        <p class="text-sm font-medium">{{ question.prompt }}</p>
        <div class="flex flex-col gap-1.5">
          <UButton
            v-for="option in question.options"
            :key="option.value"
            block
            size="sm"
            color="neutral"
            variant="soft"
            @click="answerQuestion(question.id, option.value)"
          >
            {{ option.label }}
          </UButton>
        </div>
      </div>
    </div>

    <p v-if="speechError" class="text-sm text-amber-700 dark:text-amber-400">
      {{ speechError }}
    </p>

    <UFormField :label="t('quickCapture.lessonType')">
      <div class="flex items-center gap-2">
        <select v-model="form.lessonTypeId" :class="[captureSelectClass, 'min-w-0 flex-1']">
          <option value="">{{ t("quickCapture.noLessonType") }}</option>
          <option v-for="lessonType in options?.lessonTypes || []" :key="lessonType.id" :value="lessonType.id">
            {{ lessonType.name }}
          </option>
        </select>
        <span
          v-if="useTypeDuration"
          class="shrink-0 text-sm font-medium tabular-nums text-neutral-600 dark:text-neutral-400"
        >
          {{ t("quickCapture.minutes", { minutes: effectiveDuration }) }}
        </span>
        <UCheckbox v-if="!isEditing" v-model="isDraft" :label="t('quickCapture.draft')" class="shrink-0" />
      </div>
    </UFormField>

    <div v-if="visibleSuggestedSlots.length" class="flex flex-wrap items-center gap-2 text-sm">
      <span class="text-neutral-600 dark:text-neutral-400">
        {{ visibleSuggestedSlots.length > 1 ? t("quickCapture.freeSlotsSuggestion") : t("quickCapture.firstFreeSlot") }}
      </span>
      <UButton
        v-for="slot in visibleSuggestedSlots"
        :key="`${slot.startsAt}:${slot.teacherId}`"
        size="xs"
        color="primary"
        :variant="slotIsSelected(slot) ? 'solid' : 'soft'"
        icon="i-lucide-clock"
        class="tabular-nums"
        @click="applySuggestedSlot(slot)"
      >
        {{ slot.time }}<template v-if="slot.teacherName"> · {{ slot.teacherName }}</template>
      </UButton>
    </div>
    <p
      v-else-if="hasAvailability && !availabilityLoading && !suggestedSlots.length && form.date"
      class="text-sm text-neutral-500"
    >
      {{ t("quickCapture.noFreeSlotOnDay") }}
    </p>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <UFormField :label="t('quickCapture.date')" class="col-span-2 sm:col-span-1">
        <UInput v-model="form.date" type="date" size="md" class="w-full" :ui="captureInputUi" />
      </UFormField>
      <UFormField :label="t('quickCapture.timeFrom')">
        <UInput v-model="form.time" type="time" size="md" class="w-full" :ui="captureInputUi" />
      </UFormField>
      <UFormField>
        <template #label>
          <span class="inline-flex items-center gap-1">
            {{ t("quickCapture.timeTo") }}
            <FieldInfoPopover :aria-label="t('quickCapture.endTimeAria')">
              {{ t("quickCapture.endTimeInfo") }}
            </FieldInfoPopover>
          </span>
        </template>
        <UInput v-model="endTime" type="time" size="md" class="w-full" :ui="captureInputUi" />
      </UFormField>
    </div>

    <div
      v-if="unavailableSelectedLabel || noTeacherAvailable || teacherReplacedHint"
      class="space-y-1.5 text-sm"
    >
      <p v-if="noTeacherAvailable" class="text-amber-700 dark:text-amber-400">
        {{ t("quickCapture.noTeacherFree", { teacher: teacherLabel }) }}
      </p>
      <p v-else-if="unavailableSelectedLabel" class="text-amber-700 dark:text-amber-400">
        {{ unavailableSelectedLabel }}.
      </p>
      <p v-if="teacherReplacedHint" class="flex items-start gap-1.5 text-primary-700 dark:text-primary-300">
        <UIcon name="i-lucide-refresh-cw" class="mt-0.5 size-3.5 shrink-0" />
        {{ teacherReplacedHint }}
      </p>
    </div>

    <UFormField v-if="isEditing" :label="t('quickCapture.status')">
      <div class="flex flex-wrap gap-1.5">
        <UButton
          v-for="status in statusOptions"
          :key="status"
          size="sm"
          :color="statusButtonColor(status)"
          :variant="statusButtonVariant(status)"
          :class="statusButtonClass(status)"
          @click="form.status = status"
        >
          {{ t(`appointment.status.${status}`) }}
        </UButton>
      </div>
    </UFormField>

    <div v-if="!useTypeDuration" class="space-y-1.5">
      <span class="text-sm text-neutral-600 dark:text-neutral-400">{{ t("quickCapture.duration") }}</span>
      <div class="flex flex-wrap gap-1.5">
        <UButton
          v-for="minutes in durationOptions"
          :key="minutes"
          size="xs"
          :variant="form.durationMinutes === minutes ? 'soft' : 'ghost'"
          :color="form.durationMinutes === minutes ? 'primary' : 'neutral'"
          @click="form.durationMinutes = minutes"
        >
          {{ t("quickCapture.minutes", { minutes }) }}
        </UButton>
      </div>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField v-if="canPlanAllAppointments || colleagueNames" class="sm:col-span-2">
        <template #label>
          <span class="inline-flex items-center gap-1">
            {{ teacherLabel }}
            <FieldInfoPopover
              v-if="canPlanAllAppointments && (options?.teachers || []).length"
              :aria-label="t('quickCapture.teacherPickerAria', { teacher: teacherLabel })"
            >
              {{ t("quickCapture.teacherPickerInfo", { teacher: teacherLabel }) }}
            </FieldInfoPopover>
          </span>
        </template>
        <template v-if="canPlanAllAppointments">
          <TeacherPicker
            v-if="(options?.teachers || []).length"
            v-model="form.teacherIds"
            :options="pickerTeachers"
            :label="teacherLabel"
            :highlight-id="primaryTenant?.teacherProfileId"
            :hints="teacherHints"
          />
          <p v-else class="text-sm text-neutral-500">{{ t("quickCapture.noTeachers", { teacher: teacherLabel }) }}</p>
        </template>
        <p v-else class="text-sm text-neutral-600 dark:text-neutral-400">
          {{ t("quickCapture.withColleagues", { names: colleagueNames }) }}
        </p>
      </UFormField>

      <UFormField v-if="resourcesEnabled" :label="t('quickCapture.resource')">
        <select v-model="form.resourceId" :class="captureSelectClass">
          <option value="">{{ t("quickCapture.noResource") }}</option>
          <option v-for="resource in options?.resources || []" :key="resource.id" :value="resource.id">
            {{ t("quickCapture.resourceOption", { name: resource.name, capacity: resource.capacity }) }}
          </option>
        </select>
      </UFormField>
    </div>

    <UFormField v-if="form.status === 'draft'">
      <template #label>
        <span class="inline-flex items-center gap-1">
          {{ t("quickCapture.reminder") }}
          <FieldInfoPopover :aria-label="t('quickCapture.reminderAria')">
            {{ t("quickCapture.reminderInfo") }}
          </FieldInfoPopover>
        </span>
      </template>
      <div class="space-y-2">
        <UInput
          v-model="form.reminderText"
          size="md"
          class="w-full"
          :ui="captureInputUi"
          :placeholder="t('quickCapture.reminderPlaceholder')"
        />
        <div class="grid grid-cols-2 gap-3">
          <UInput v-model="form.reminderDate" type="date" size="md" class="w-full" :ui="captureInputUi" />
          <UInput v-model="form.reminderTime" type="time" size="md" class="w-full" :ui="captureInputUi" />
        </div>
      </div>
    </UFormField>

    <UFormField class="w-full">
      <template #label>
        <span class="inline-flex items-center gap-1">
          {{ t("quickCapture.phone") }}
          <FieldInfoPopover
            v-if="showCallHintsOptInHint"
            :aria-label="t('quickCapture.callHintsAria')"
          >
            {{ t("quickCapture.callHintsInfo") }}
          </FieldInfoPopover>
        </span>
      </template>
      <div class="space-y-1.5">
        <div class="flex gap-2">
          <UInput
            v-model="form.phone"
            type="tel"
            size="md"
            class="min-w-0 flex-1 w-full"
            :ui="captureInputUi"
            placeholder="+43 …"
          />
          <UButton
            v-if="canPickContact"
            type="button"
            size="sm"
            variant="ghost"
            color="neutral"
            icon="i-lucide-contact"
            :loading="pickingContact"
            class="shrink-0"
            :title="t('quickCapture.pickContact')"
            @click="pickDeviceContact"
          />
        </div>
        <div v-if="callHints.length" class="flex flex-col gap-0.5">
          <button
            v-for="hint in callHints"
            :key="`${hint.lastSeenAt}:${hint.e164 || hint.raw}`"
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800/80"
            @click="applyCallHint(hint)"
          >
            <span class="min-w-0 truncate" :class="hint.active ? 'font-medium' : ''">{{ hint.e164 || hint.raw }}</span>
            <span
              v-if="hint.active"
              class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary-700 dark:text-primary-300"
            >
              <span class="inline-block size-2 rounded-full bg-green-500 animate-pulse" />
              {{ t("quickCapture.callActive") }}
            </span>
            <span v-else class="shrink-0 text-xs text-neutral-500 tabular-nums">{{ formatCallHintTime(hint.lastSeenAt) }}</span>
          </button>
        </div>
        <div v-if="canManageDeviceContact" class="flex flex-wrap items-center gap-2">
          <UButton
            v-if="canSaveDeviceContact"
            type="button"
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-user-plus"
            :loading="savingDeviceContact || checkingDeviceContact"
            @click="saveDeviceContact"
          >
            {{ t("quickCapture.saveToPhone") }}
          </UButton>
          <UButton
            v-else-if="canRemoveDeviceContact"
            type="button"
            size="xs"
            variant="ghost"
            color="neutral"
            icon="i-lucide-user-minus"
            :loading="removingDeviceContact || checkingDeviceContact"
            @click="removeDeviceContact"
          >
            {{ t("quickCapture.removeFromPhone") }}
          </UButton>
          <span v-if="deviceContactStatusLabel || deviceContactHint" class="text-xs text-neutral-500">
            {{ deviceContactHint || deviceContactStatusLabel }}
          </span>
        </div>
      </div>
    </UFormField>

    <div class="flex items-center justify-end gap-2 pt-1">
      <UButton size="md" variant="ghost" color="neutral" @click="emit('cancel')">{{ t("quickCapture.close") }}</UButton>
      <UButton
        size="md"
        color="primary"
        :disabled="!canSave || loading"
        :loading="saving"
        @click="saveAppointment"
      >
        {{ t("quickCapture.save") }}
      </UButton>
    </div>
  </div>
</template>
