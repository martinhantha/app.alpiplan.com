import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI, ThinkingLevel, type ThinkingConfig } from "@google/genai";
import { z } from "zod";

/**
 * AI extraction for Schnellerfassung. The model only structures the text; IDs are
 * resolved server-side against the tenant catalog (see resolveExtractedIntent).
 * Customers are deliberately NOT sent to the model (data minimisation).
 *
 * Provider is chosen globally via env: ASSISTANT_AI_PROVIDER=anthropic|gemini, or
 * automatically from whichever API key is present (Anthropic first).
 */

export type AiProvider = "anthropic" | "gemini";

const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-haiku-5-5",
  // Alias maintained by Google; survives model retirements (gemini-2.5-flash was closed for new accounts).
  // Lite answered in ~1 s during testing (2026-10-30); gemini-flash-latest took 34 s or was overloaded.
  gemini: "gemini-flash-lite-latest",
};

function hasKey(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

export function aiIntentProvider(): AiProvider | null {
  const forced = process.env.ASSISTANT_AI_PROVIDER?.trim().toLowerCase();
  if (forced === "gemini") return hasKey("GEMINI_API_KEY") ? "gemini" : null;
  if (forced === "anthropic") return hasKey("ANTHROPIC_API_KEY") ? "anthropic" : null;
  if (hasKey("ANTHROPIC_API_KEY")) return "anthropic";
  if (hasKey("GEMINI_API_KEY")) return "gemini";
  return null;
}

export function aiIntentModel(provider: AiProvider): string {
  const override = provider === "gemini" ? process.env.GEMINI_INTENT_MODEL : process.env.ANTHROPIC_INTENT_MODEL;
  return override?.trim() || DEFAULT_MODELS[provider];
}

/** "provider/model" for logs; falls back to "none" when no provider is configured. */
export function aiIntentLabel(): string {
  const provider = aiIntentProvider();
  return provider ? `${provider}/${aiIntentModel(provider)}` : "none";
}

export function isAiIntentAvailable(): boolean {
  return aiIntentProvider() !== null;
}

const ExtractionSchema = z.object({
  date: z.string().nullable().describe("Appointment date as YYYY-MM-DD, resolved relative to today; null if not mentioned"),
  time: z.string().nullable().describe("Start time as HH:MM (24h); null unless a concrete clock time is given"),
  durationMinutes: z.number().int().nullable().describe("Duration in minutes; null if not mentioned"),
  teacherNames: z.array(z.string()).describe("All staff members assigned to the appointment, exact spelling from the staff list; empty if none"),
  lessonTypeName: z.string().nullable().describe("Exact spelling from the appointment-type list, or null"),
  resourceName: z.string().nullable().describe("Exact spelling from the resource list, or null"),
  customerNames: z.array(z.string()).describe("Customers/passengers/students the appointment is for, properly capitalised, in the order mentioned; empty if none"),
  status: z.enum(["draft", "confirmed"]).nullable().describe("draft when the text says Entwurf/vorläufig/unverbindlich/bozza, confirmed when it says bestätigt/fix/confermato; null otherwise"),
  reminderDate: z.string().nullable().describe("Reminder date as YYYY-MM-DD; relative wording like '2 Tage vorher' is computed from the appointment date; null if no reminder"),
  reminderTime: z.string().nullable().describe("Reminder time HH:MM if stated; null otherwise"),
  reminderText: z.string().nullable().describe("What to do at the reminder, e.g. 'Wetterlage checken'; null if none"),
  phone: z.string().nullable().describe("Phone number, digits with optional leading + or 0; null if none"),
  note: z.string().nullable().describe("Remaining meaningful information not covered by other fields; null if nothing is left"),
});

export type AiExtraction = z.infer<typeof ExtractionSchema>;

/** Same shape as ExtractionSchema, as JSON Schema for Gemini's responseJsonSchema. */
const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    date: { anyOf: [{ type: "string" }, { type: "null" }], description: "Appointment date as YYYY-MM-DD, resolved relative to today; null if not mentioned" },
    time: { anyOf: [{ type: "string" }, { type: "null" }], description: "Start time as HH:MM (24h); null unless a concrete clock time is given" },
    durationMinutes: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Duration in minutes; null if not mentioned" },
    teacherNames: { type: "array", items: { type: "string" }, description: "All staff members assigned to the appointment, exact spelling from the staff list; empty if none" },
    lessonTypeName: { anyOf: [{ type: "string" }, { type: "null" }], description: "Exact spelling from the appointment-type list, or null" },
    resourceName: { anyOf: [{ type: "string" }, { type: "null" }], description: "Exact spelling from the resource list, or null" },
    customerNames: { type: "array", items: { type: "string" }, description: "Customers/passengers/students the appointment is for, properly capitalised, in the order mentioned; empty if none" },
    status: { anyOf: [{ type: "string", enum: ["draft", "confirmed"] }, { type: "null" }], description: "draft when the text says Entwurf/vorläufig/unverbindlich/bozza, confirmed when it says bestätigt/fix/confermato; null otherwise" },
    reminderDate: { anyOf: [{ type: "string" }, { type: "null" }], description: "Reminder date as YYYY-MM-DD; relative wording like '2 Tage vorher' is computed from the appointment date; null if no reminder" },
    reminderTime: { anyOf: [{ type: "string" }, { type: "null" }], description: "Reminder time HH:MM if stated; null otherwise" },
    reminderText: { anyOf: [{ type: "string" }, { type: "null" }], description: "What to do at the reminder, e.g. 'Wetterlage checken'; null if none" },
    phone: { anyOf: [{ type: "string" }, { type: "null" }], description: "Phone number, digits with optional leading + or 0; null if none" },
    note: { anyOf: [{ type: "string" }, { type: "null" }], description: "Remaining meaningful information not covered by other fields; null if nothing is left" },
  },
  required: ["date", "time", "durationMinutes", "teacherNames", "lessonTypeName", "resourceName", "customerNames", "status", "reminderDate", "reminderTime", "reminderText", "phone", "note"],
  additionalProperties: false,
} as const;

export interface AiIntentCatalog {
  now: Date;
  timeZone: string;
  teacherLabel: string;
  teachers: string[];
  lessonTypes: { name: string; defaultDurationMin: number | null }[];
  resources: string[];
  /** Tenant-specific vocabulary (aliases, nicknames); free text written by the tenant admin. */
  hints?: string | null;
}

export interface AiIntentResult {
  extraction: AiExtraction;
  provider: AiProvider;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

function list(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- (none)";
}

/** Stable per tenant so the prompt prefix can be cached; nothing time-dependent in here. */
function buildSystemPrompt(catalog: AiIntentCatalog): string {
  const lessonTypes = catalog.lessonTypes.map((item) =>
    item.defaultDurationMin ? `${item.name} (default ${item.defaultDurationMin} min)` : item.name,
  );
  const hints = catalog.hints?.trim();
  return [
    "You extract appointment data for a scheduling app used by flight schools, ski schools and similar businesses.",
    "The input is a short note typed or dictated by staff. It may be German, Italian or English, may use dialect,",
    "abbreviations, and may contain speech-recognition errors. Reply only with the structured object.",
    "",
    "Rules:",
    `- Staff members are called "${catalog.teacherLabel}". If a name in the text resembles an entry in the staff list`,
    "  (typo, mishearing, first name only), output that entry's exact spelling in teacherNames. An appointment can",
    "  have several staff members (e.g. two pilots, 'mit Sepp und Martin'): list all of them. Empty list if none.",
    "  If a bare first name fits several staff members (two 'Martin'), output just that first name as spoken and do",
    "  not pick one; the app will ask the user.",
    "- Do the same for lessonTypeName (appointment types) and resourceName (rooms, aircraft, equipment).",
    "- customerNames are the people the appointment is for (Passagier, Kunde, Schüler, Gast, Teilnehmer, cliente, passeggero,",
    "  allievo, ospite), in the order mentioned. Keep the spelling as given, capitalise properly, drop role words.",
    "  Never put a staff member here.",
    "- Later statements override earlier ones: 'morgen ... Termin ist doch am 16. November' means 16 November, not tomorrow.",
    "- status: 'Entwurf', 'vorläufig', 'unverbindlich', 'bozza' -> draft; 'bestätigt', 'fix', 'confermato' -> confirmed; else null.",
    "- Reminder: 'Erinnerung 2 Tage vorher, Wetter checken' -> reminderDate = appointment date minus 2 days, reminderText =",
    "  'Wetter checken'. 'einen Tag vorher' -> minus 1 day, 'am Vortag' -> minus 1 day. reminderTime only when stated.",
    "  Reminder details never go into note.",
    "- date: resolve relative expressions (heute, morgen, übermorgen, Freitag, nächste Woche Dienstag, domani, venerdì)",
    "  against the current date given in the message. A bare weekday means the next occurrence, today if it is today.",
    "  Day.month without year means the next such date. Output YYYY-MM-DD.",
    "- time: only when a concrete clock time is said: 'um 14 Uhr' -> 14:00, 'halb drei' -> 14:30, 'viertel vor zehn' -> 09:45,",
    "  '9.30' -> 09:30, 'alle 15' -> 15:00. Vague parts of day (früh, vormittags, nachmittags, abends) stay null; mention them in note.",
    "  Ambiguous 12-hour times default to daytime business hours (e.g. 'um 3' -> 15:00, 'um 9' -> 09:00).",
    "- durationMinutes: '2h', '2 Stunden', 'anderthalb Stunden' -> 90, '45 min'. Null if absent; never copy a default",
    "  duration from the appointment-type list. resourceName only when the resource itself is named in the text.",
    "- phone: keep digits, convert 'plus' to '+', remove spaces/dashes. Null if absent.",
    "- note: short leftover info (wishes, remarks, vague times). Do not repeat fields you already extracted. Null if empty.",
    "- Never invent data. Null means not mentioned.",
    "",
    `Staff (${catalog.teacherLabel}):`,
    list(catalog.teachers),
    "",
    "Appointment types:",
    list(lessonTypes),
    "",
    "Resources:",
    list(catalog.resources),
    ...(hints ? ["", "Tenant-specific vocabulary and aliases (authoritative):", hints] : []),
  ].join("\n");
}

function buildUserPrompt(text: string, now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return `Current date: ${date} (${weekday}), current time ${time}, time zone ${timeZone}.\n\nText:\n${text}`;
}

/** Hard limit per model call; the rule parser answers when it is exceeded. */
const TIMEOUT_MS = Math.max(3_000, Number(process.env.AI_INTENT_TIMEOUT_MS) || 20_000);

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  }
  return anthropicClient;
}

/** Minimal thinking keeps latency low for a plain extraction. Gemini 2.5 uses budgets, 3.x uses levels. */
function geminiThinkingConfig(model: string): ThinkingConfig | undefined {
  if (/^gemini-2\.5-/.test(model)) return model.includes("flash") ? { thinkingBudget: 0 } : undefined;
  return { thinkingLevel: ThinkingLevel.MINIMAL };
}

function isGeminiBadRequest(error: unknown): boolean {
  const status = (error as { status?: number; code?: number })?.status ?? (error as { code?: number })?.code;
  return status === 400 || /INVALID_ARGUMENT|thinking/i.test(String((error as Error)?.message ?? ""));
}

let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY?.trim(), httpOptions: { timeout: TIMEOUT_MS } });
  }
  return geminiClient;
}

async function extractWithAnthropic(
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<Omit<AiIntentResult, "provider" | "model" | "latencyMs">> {
  const response = await getAnthropic().messages.parse({
    model,
    max_tokens: 1024,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userPrompt }],
    output_config: { format: zodOutputFormat(ExtractionSchema), effort: "low" },
  });
  if (response.stop_reason === "refusal") {
    throw new Error("AI model refused the request");
  }
  if (!response.parsed_output) {
    throw new Error(`AI model returned no parsable output (stop_reason=${response.stop_reason})`);
  }
  return {
    extraction: response.parsed_output,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}

async function extractWithGemini(
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<Omit<AiIntentResult, "provider" | "model" | "latencyMs">> {
  const baseConfig = {
    systemInstruction: systemPrompt,
    responseMimeType: "application/json",
    responseJsonSchema: EXTRACTION_JSON_SCHEMA,
    temperature: 0,
  };
  const request = (thinkingConfig: ThinkingConfig | undefined) =>
    getGemini().models.generateContent({
      model,
      contents: userPrompt,
      config: thinkingConfig ? { ...baseConfig, thinkingConfig } : baseConfig,
    });
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request(geminiThinkingConfig(model));
  } catch (error) {
    // Older/newer models disagree on thinking settings; retry once with the model's defaults.
    if (!isGeminiBadRequest(error)) throw error;
    response = await request(undefined);
  }
  const text = response.text;
  if (!text) {
    const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "unknown";
    throw new Error(`Gemini returned no text (reason=${reason})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }
  const parsed = ExtractionSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Gemini output did not match the schema: ${parsed.error.message}`);
  }
  const usage = response.usageMetadata;
  return {
    extraction: parsed.data,
    usage: {
      inputTokens: usage?.promptTokenCount ?? 0,
      outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
      cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
    },
  };
}

export async function extractIntentWithAi(text: string, catalog: AiIntentCatalog): Promise<AiIntentResult> {
  const provider = aiIntentProvider();
  if (!provider) {
    throw new Error("No AI provider configured (ANTHROPIC_API_KEY or GEMINI_API_KEY)");
  }
  const model = aiIntentModel(provider);
  const systemPrompt = buildSystemPrompt(catalog);
  const userPrompt = buildUserPrompt(text, catalog.now, catalog.timeZone);
  const started = Date.now();
  const result =
    provider === "gemini"
      ? await extractWithGemini(model, systemPrompt, userPrompt)
      : await extractWithAnthropic(model, systemPrompt, userPrompt);
  return { ...result, provider, model, latencyMs: Date.now() - started };
}
