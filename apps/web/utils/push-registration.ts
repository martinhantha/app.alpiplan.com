import { ref } from "vue";
import { Capacitor } from "@capacitor/core";
import { AlpiplanDevice } from "@alpiplan/capacitor-call-hints";
import { queueNativePermissionRequest } from "~/utils/native-permission-queue";

export type NativePushRegistrationState =
  | "idle"
  | "unsupported"
  | "registering"
  | "ok"
  | "permission-denied"
  | "no-token"
  | "error";

export interface NativePushRegistration {
  state: NativePushRegistrationState;
  /** Technical detail for the error state (shown in settings). */
  message?: string;
  at?: number;
}

/** Last outcome of registerNativePushToken, shown in Einstellungen → Benachrichtigungen. */
export const nativePushRegistration = ref<NativePushRegistration>({ state: "idle" });

let lastToken: string | null = null;
let registering = false;

function setState(state: NativePushRegistrationState, message?: string) {
  nativePushRegistration.value = { state, message, at: Date.now() };
}

function errorText(error: unknown): string {
  const err = error as { data?: { message?: string }; statusMessage?: string; message?: string };
  return err?.data?.message || err?.statusMessage || err?.message || String(error);
}

export async function registerNativePushToken(): Promise<NativePushRegistration> {
  if (!import.meta.client) return nativePushRegistration.value;
  if (!Capacitor.isNativePlatform()) {
    setState("unsupported");
    return nativePushRegistration.value;
  }
  const platform = Capacitor.getPlatform();
  if (platform !== "android" && platform !== "ios") {
    setState("unsupported");
    return nativePushRegistration.value;
  }
  if (registering) return nativePushRegistration.value;
  registering = true;
  setState("registering");
  try {
    let permissionDenied = false;
    try {
      const permission = await queueNativePermissionRequest(() =>
        AlpiplanDevice.requestPermissions({ alias: "notifications" }),
      );
      const state = String((permission as { notifications?: string } | undefined)?.notifications ?? "");
      permissionDenied = state === "denied";
    } catch {
      // Older plugin builds without the notifications alias: keep going, the token is independent.
    }
    const result = await AlpiplanDevice.getPushToken();
    const token = result.token?.trim();
    if (!token) {
      setState("no-token");
      return nativePushRegistration.value;
    }
    lastToken = token;
    await $fetch("/api/auth/push-token", {
      method: "POST",
      credentials: "include",
      body: { token, platform },
    });
    setState(permissionDenied ? "permission-denied" : "ok");
  } catch (error) {
    setState("error", errorText(error));
  } finally {
    registering = false;
  }
  return nativePushRegistration.value;
}

export async function unregisterNativePushToken(): Promise<void> {
  const token = lastToken;
  lastToken = null;
  if (!token) return;
  try {
    await $fetch("/api/auth/push-token", {
      method: "DELETE",
      credentials: "include",
      body: { token },
    });
  } catch {
    // Session may already be gone.
  }
}
