import type { CallHint } from "@alpiplan/device-capabilities";
import type { PermissionState, PluginListenerHandle } from "@capacitor/core";

export interface CallHintsPermissionStatus {
  /** Android 10+: Alpiplan holds the "caller ID & spam" role and sees calls from then on. */
  callerId: PermissionState;
}

export interface CallHintsPlugin {
  getRecentCallHints(options?: { limit?: number }): Promise<{ hints: CallHint[] }>;
  checkPermissions(): Promise<CallHintsPermissionStatus>;
  requestPermissions(): Promise<CallHintsPermissionStatus>;
  /** Opens the system "default apps" screen, for when the role dialog is no longer shown. */
  openCallerIdSettings(): Promise<void>;
  addListener(eventName: "callStateChanged", listenerFunc: () => void): Promise<PluginListenerHandle>;
}

export interface AlpiplanDevicePermissionStatus {
  microphone: PermissionState;
  contacts: PermissionState;
  notifications?: PermissionState;
}

export interface AlpiplanDevicePlugin {
  checkPermissions(): Promise<AlpiplanDevicePermissionStatus>;
  requestPermissions(options?: {
    alias?: "microphone" | "contacts" | "notifications";
  }): Promise<AlpiplanDevicePermissionStatus>;
  requestAllPermissions(): Promise<AlpiplanDevicePermissionStatus>;
  requestMicrophone(): Promise<AlpiplanDevicePermissionStatus>;
  openAppSettings(): Promise<void>;
  openWhatsApp(options: { phone: string; app?: "whatsapp" | "business" }): Promise<void>;
  showLocalNotification(options: { title: string; body: string; id?: string }): Promise<void>;
  /** `error` explains a missing token (e.g. SERVICE_NOT_AVAILABLE, FIS_AUTH_ERROR); older builds omit it. */
  getPushToken(): Promise<{ token?: string | null; error?: string | null }>;
  /** `hints`: known names (staff, customers, types) used to bias recognition on Android 13+. */
  startSpeechRecognition(options?: { lang?: string; hints?: string[] }): Promise<void>;
  stopSpeechRecognition(): Promise<void>;
  addListener(
    eventName: "speechTranscript",
    listenerFunc: (event: { transcript: string; alternatives?: string[]; isFinal: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "speechError",
    listenerFunc: (event: { message: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(eventName: "speechSessionEnd", listenerFunc: () => void): Promise<PluginListenerHandle>;
  saveLocalContact(options: {
    displayName: string;
    phone?: string;
    note?: string;
    organization?: string;
  }): Promise<{ contactId: string }>;
  findContactByPhone(options: { phone: string }): Promise<{
    found: boolean;
    contactId?: string;
    displayName?: string;
    googleSynced?: boolean;
  }>;
  deleteContactByPhone(options: { phone: string }): Promise<{ deleted: number }>;
}
