import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

/**
 * AI extraction for Schnellerfassung. The model only structures the text; IDs are
 * resolved server-side against the tenant catalog (see resolveExtractedIntent).
 * Customers are deliberately NOT sent to the model (data minimisation).
 */

const DEFAULT_MODEL = "claude-haiku-5-5";

export function aiIntentModel(): string {
  return process.env.ANTHROPIC_INTENT_MODEL?.trim() || DEFAULT_MODEL;
}

export function isAiIntentAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

const ExtractionSchema = z.object({
  date: z.string().nullable().describe("Appointment date as YYYY-MM-DD, resolved relative to today; null if not mentioned"),
  time: z.string().nullable().describe("Start time as HH:MM (24h); null unless a concrete clock time is given"),
  durationMinutes: z.number().int().nullable().describe("Duration in minutes; null if not mentioned"),
  teacherName: z.string().nullable().describe("Exact spelling from the staff list, or null"),
  lessonTypeName: z.string().nullable().describe("Exact spelling from the appointment-type list, or null"),
  resourceName: z.string().nullable().describe("Exact spelling from the resource list, or null"),
  customerName: z.string().nullable().describe("Name of the customer/passenger/student the appointment is for, properly capitalised; null if none"),
  phone: z.string().nullable().describe("Phone number, digits with optional leading + or 0; null if none"),
  note: z.string().nullable().describe("Remaining meaningful information not covered by other fields; null if nothing is left"),
});

export type AiExtraction = z.infer<typeof ExtractionSchema>;

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
    "  (typo, mishearing, first name only), output that entry's exact spelling in teacherName. Otherwise null.",
    "- Do the same for lessonTypeName (appointment types) and resourceName (rooms, aircraft, equipment).",
    "- customerName is the person the appointment is for (Passagier, Kunde, Schüler, Gast, Teilnehmer, cliente, passeggero,",
    "  allievo, ospite). Keep the spelling as given, capitalise properly, drop role words. Never put a staff member here.",
    "- date: resolve relative expressions (heute, morgen, übermorgen, Freitag, nächste Woche Dienstag, domani, venerdì)",
    "  against the current date given in the message. A bare weekday means the next occurrence, today if it is today.",
    "  Day.month without year means the next such date. Output YYYY-MM-DD.",
    "- time: only when a concrete clock time is said: 'um 14 Uhr' -> 14:00, 'halb drei' -> 14:30, 'viertel vor zehn' -> 09:45,",
    "  '9.30' -> 09:30, 'alle 15' -> 15:00. Vague parts of day (früh, vormittags, nachmittags, abends) stay null; mention them in note.",
    "  Ambiguous 12-hour times default to daytime business hours (e.g. 'um 3' -> 15:00, 'um 9' -> 09:00).",
    "- durationMinutes: '2h', '2 Stunden', 'anderthalb Stunden' -> 90, '45 min'. Null if absent.",
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

function localDateLine(now: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return `Current date: ${date} (${weekday}), current time ${time}, time zone ${timeZone}.`;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ timeout: 12_000, maxRetries: 1 });
  }
  return client;
}

export async function extractIntentWithAi(text: string, catalog: AiIntentCatalog): Promise<AiIntentResult> {
  const model = aiIntentModel();
  const started = Date.now();
  const response = await getClient().messages.parse({
    model,
    max_tokens: 1024,
    system: [{ type: "text", text: buildSystemPrompt(catalog), cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `${localDateLine(catalog.now, catalog.timeZone)}\n\nText:\n${text}`,
      },
    ],
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
    model: response.model || model,
    latencyMs: Date.now() - started,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    },
  };
}
