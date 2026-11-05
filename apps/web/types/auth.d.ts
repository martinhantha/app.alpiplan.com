export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  isSuperadmin: boolean;
  nextDayBriefingEnabled: boolean;
  /** Europe/Rome local time, minutes after midnight */
  nextDayBriefingMinutes: number;
  /** As tenant admin: alert when someone else moves an appointment */
  appointmentMovedAlertsEnabled: boolean;
  /** Reminder 15 minutes before own appointments */
  appointmentReminderEnabled: boolean;
  /** small | medium | large */
  uiScale: "small" | "medium" | "large";
}

export interface AuthMembership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "STAFF" | "END_CUSTOMER";
  useDefaultDuration: boolean;
  teacherLabel: string;
  resourcesEnabled: boolean;
  speechRecognitionEnabled: boolean;
  speechLanguage: string;
  aiParsingEnabled: boolean;
  assistantHints: string | null;
  autoCompleteAppointments: boolean;
  autoCompleteAfterMinutes: number;
  teacherProfileId: string | null;
  performsAppointments: boolean;
}

export interface AuthSession {
  user: AuthUser;
  memberships: AuthMembership[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
