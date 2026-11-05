import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { AlpiplanDevice } from "@alpiplan/capacitor-call-hints";
import { pickTranscript } from "./speech-transcript";

export function isNativeAndroidSpeech() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export interface NativeSpeechOptions {
  /** BCP-47 tag, e.g. de-DE, de-AT, it-IT (tenant setting). */
  lang?: string;
  /** Known names used to bias recognition (Android 13+) and to pick between alternatives. */
  hints?: string[];
}

export async function startNativeSpeech(
  handlers: {
    onTranscript: (transcript: string, isFinal: boolean) => void;
    onSessionEnd?: () => void;
    onError: (message: string) => void;
  },
  options: NativeSpeechOptions = {},
): Promise<() => Promise<void>> {
  const hints = (options.hints ?? []).filter((hint) => typeof hint === "string" && hint.trim()).slice(0, 500);
  const handles: PluginListenerHandle[] = [
    await AlpiplanDevice.addListener("speechTranscript", (event) => {
      const transcript = pickTranscript(event.transcript ?? "", event.alternatives, hints);
      if (!transcript) return;
      handlers.onTranscript(transcript, Boolean(event.isFinal));
    }),
    await AlpiplanDevice.addListener("speechSessionEnd", () => {
      handlers.onSessionEnd?.();
    }),
    await AlpiplanDevice.addListener("speechError", (event) => {
      handlers.onError(event.message || "Spracherkennung fehlgeschlagen.");
    }),
  ];
  await AlpiplanDevice.startSpeechRecognition({ lang: options.lang || "de-DE", hints });
  return async () => {
    try {
      await AlpiplanDevice.stopSpeechRecognition();
    } catch {
      // Already stopped.
    }
    await Promise.all(handles.map((handle) => handle.remove()));
  };
}
