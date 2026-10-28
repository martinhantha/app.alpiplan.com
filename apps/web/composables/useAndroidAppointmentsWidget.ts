import { Capacitor } from "@capacitor/core";
import { AppointmentsWidget, type WidgetAppointmentPayload } from "@alpiplan/capacitor-appointments-widget";
import { $fetch } from "ofetch";
import { APPOINTMENT_LIVE_EVENT } from "~/types/live-events";
import {
  formatAppointmentTeachers,
  resolveAppointmentDisplayName,
  resolveAppointmentPhone,
} from "~/utils/appointment-contact";
import { readWhatsAppApp } from "~/utils/whatsapp";
import { normalizeUiScale } from "~/utils/ui-scale";

/** Bound the sync window while including past confirmed and far-future bookings. */
const APPOINTMENT_WINDOW_MS = 120 * 24 * 60 * 60 * 1000;
const POLL_MS = 5 * 60_000;
const MAX_WIDGET_ITEMS = 10;

interface AppointmentListItem {
  id: string;
  startsAt: string;
  status: string;
  version: number;
  appointmentContactText: string | null;
  appointmentPhoneRaw: string | null;
  appointmentPhoneE164: string | null;
  teacher: { id: string; displayName: string } | null;
  teachers?: { id: string; displayName: string }[] | null;
  customer: {
    displayName: string | null;
    phones?: { e164: string | null; raw: string | null; isPrimary: boolean }[];
  } | null;
}

function formatTimeLabel(startsAt: string) {
  try {
    return new Intl.DateTimeFormat("de-DE", {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(startsAt));
  } catch {
    return startsAt;
  }
}

function toWidgetPayload(
  item: AppointmentListItem,
  tenantName: string | null | undefined,
  showTeachers: boolean,
): WidgetAppointmentPayload {
  return {
    id: item.id,
    version: item.version,
    status: item.status,
    startsAt: item.startsAt,
    title: resolveAppointmentDisplayName(item, tenantName),
    phone: resolveAppointmentPhone(item),
    timeLabel: formatTimeLabel(item.startsAt),
    teachers: showTeachers ? formatAppointmentTeachers(item) : null,
  };
}

export function useAndroidAppointmentsWidget() {
  const { user, primaryTenant, canPlanAllAppointments } = useAuth();
  const colorMode = useColorMode();

  const enabled = computed(
    () =>
      Capacitor.isNativePlatform() &&
      Capacitor.getPlatform() === "android" &&
      Boolean(user.value) &&
      Capacitor.isPluginAvailable("AppointmentsWidget"),
  );

  let pollTimer: ReturnType<typeof setInterval> | undefined;

  async function syncWidget() {
    if (!enabled.value || !import.meta.client) return;
    const tenantId = primaryTenant.value?.tenantId;
    if (!tenantId) {
      await AppointmentsWidget.clear().catch(() => {});
      return;
    }
    const now = Date.now();
    try {
      const response = await $fetch<{ data: AppointmentListItem[] }>(
        `/api/v1/tenants/${tenantId}/appointments`,
        {
          credentials: "include",
          query: {
            from: new Date(now - APPOINTMENT_WINDOW_MS).toISOString(),
            to: new Date(now + APPOINTMENT_WINDOW_MS).toISOString(),
            status: "draft,confirmed",
            pageSize: 200,
            sort: "asc",
          },
        },
      );
      const showTeachers = canPlanAllAppointments.value;
      const items = response.data
        .filter((item) => item.status !== "cancelled" && item.status !== "completed")
        .filter((item) => item.status === "confirmed" || new Date(item.startsAt).getTime() >= now)
        .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
        .slice(0, MAX_WIDGET_ITEMS)
        .map((item) => toWidgetPayload(item, primaryTenant.value?.tenantName, showTeachers));

      await AppointmentsWidget.sync({
        tenantId,
        apiBaseUrl: window.location.origin,
        appointments: items,
        darkMode: colorMode.value === "dark",
        whatsAppApp: readWhatsAppApp(),
        uiScale: normalizeUiScale(user.value?.uiScale),
        showTeachers,
      });
    } catch {
      // Keep last widget snapshot if refresh fails offline.
    }
  }

  async function clearWidget() {
    if (!import.meta.client || Capacitor.getPlatform() !== "android") return;
    if (!Capacitor.isPluginAvailable("AppointmentsWidget")) return;
    await AppointmentsWidget.clear().catch(() => {});
  }

  function onLive() {
    void syncWidget();
  }

  function onVisible() {
    if (document.visibilityState === "visible") void syncWidget();
  }

  watch(
    () =>
      [
        user.value?.id,
        primaryTenant.value?.tenantId,
        user.value?.uiScale,
        colorMode.value,
        canPlanAllAppointments.value,
      ] as const,
    () => {
      if (!user.value) void clearWidget();
      else void syncWidget();
    },
    { immediate: true },
  );

  onMounted(() => {
    pollTimer = setInterval(() => {
      void syncWidget();
    }, POLL_MS);
    window.addEventListener(APPOINTMENT_LIVE_EVENT, onLive);
    document.addEventListener("visibilitychange", onVisible);
  });

  onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer);
    window.removeEventListener(APPOINTMENT_LIVE_EVENT, onLive);
    document.removeEventListener("visibilitychange", onVisible);
  });
}
