export interface WidgetAppointmentPayload {
  id: string;
  version: number;
  status: string;
  startsAt: string;
  title: string;
  phone: string | null;
  /** Pre-formatted time/date label for the widget row */
  timeLabel: string;
  /** Comma-separated teacher (pilot) names, only sent for accounts that plan all appointments */
  teachers?: string | null;
}

export type WidgetWhatsAppApp = "whatsapp" | "business";

export interface AppointmentsWidgetSyncOptions {
  tenantId: string;
  /** Origin, e.g. https://app.alpiplan.com */
  apiBaseUrl: string;
  appointments: WidgetAppointmentPayload[];
  /** Resolved app theme (light/dark), matches Nuxt color mode. */
  darkMode: boolean;
  /** Same preference as in app settings (WhatsApp vs Business). */
  whatsAppApp?: WidgetWhatsAppApp;
  /** Account display size — scales widget type (small | medium | large). */
  uiScale?: "small" | "medium" | "large";
  /** Show teacher (pilot) names on rows, also for native background refreshes. */
  showTeachers?: boolean;
}

export interface AppointmentsWidgetPlugin {
  sync(options: AppointmentsWidgetSyncOptions): Promise<void>;
  clear(): Promise<void>;
}
