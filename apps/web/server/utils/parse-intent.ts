import { fold, fuzzyWordEquals } from "./fuzzy-name";

export interface IntentEntity {
  id: string;
  displayName: string;
}

export interface IntentCustomer extends IntentEntity {
  phones?: { e164: string | null; raw: string | null }[];
}

export interface IntentLessonType extends IntentEntity {
  defaultDurationMin: number | null;
}

export interface IntentCatalog {
  now?: Date;
  timeZone: string;
  teacherLabel: string;
  teachers: IntentEntity[];
  resources: { id: string; name: string }[];
  lessonTypes: IntentLessonType[];
  customers: IntentCustomer[];
}

export interface ClarifyingOption {
  value: string;
  label: string;
}

export interface ClarifyingQuestion {
  id: string;
  prompt: string;
  options: ClarifyingOption[];
}

export interface ParsedAppointmentIntent {
  date?: string;
  time?: string;
  durationMinutes?: number;
  teacherId?: string;
  teacherName?: string;
  /** All assigned staff (teacherId is the first); more than one e.g. for two pilots */
  teacherIds?: string[];
  teacherNames?: string[];
  resourceId?: string;
  resourceName?: string;
  lessonTypeId?: string;
  lessonTypeName?: string;
  customerId?: string;
  customerName?: string;
  createCustomer?: boolean;
  /** Further people mentioned as passengers; the data model holds one customer, the rest goes into the note */
  additionalCustomerNames?: string[];
  /** draft | confirmed when the text says so */
  status?: "draft" | "confirmed";
  reminderDate?: string;
  reminderTime?: string;
  reminderText?: string;
  phone?: string;
  note?: string;
  contactText?: string;
}

export interface ParseIntentResult {
  parsed: ParsedAppointmentIntent;
  fieldConfidence: Record<string, number>;
  clarifyingQuestions: ClarifyingQuestion[];
  suggestedDefaults: Record<string, unknown>;
}

const WEEKDAYS: Record<string, number> = {
  sonntag: 0,
  montag: 1,
  dienstag: 2,
  mittwoch: 3,
  donnerstag: 4,
  freitag: 5,
  samstag: 6,
};

const MONTHS: Record<string, number> = {
  januar: 1,
  februar: 2,
  maerz: 3,
  marz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
};

const STOP = new Set([
  "am", "an", "auf", "bei", "bitte", "das", "dem", "den", "der", "die", "dort",
  "ein", "eine", "fuer", "hier", "im", "in", "ist", "mal", "mit", "nach", "noch",
  "ok", "okay", "plus", "so", "um", "und", "von", "zu", "zum", "uhr", "heute",
  "morgen", "uebermorgen", "sind", "ist", "doch", "wir", "haben", "einen", "noch",
]);

const NAME_STOP = new Set([
  ...STOP,
  "telefon", "telefonnummer", "tel", "handy", "mobil", "nummer",
  "passagier", "passagierin", "passager", "passaschier", "passenger", "fluggast",
  "kunde", "kundin", "schueler", "schuelerin", "mitfahrer", "mitfahrerin",
  "gast", "flug", "stunde", "stunden", "minute", "minuten", "termin",
  "heisst", "namens", "genannt", "teilnehmer", "teilnehmerin",
]);

const PASSENGER_RE =
  /\b(passa[sgjch]+(?:ier|iere|ierin|er|e|in)?|passengers?|fluggaeste|fluggast|mitfahrer(?:in)?|kunden?|kundin|schueler(?:in)?|gast|gaeste|teilnehmer(?:in)?|namens)\b/i;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function zonedToday(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const week: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: week[map.weekday] ?? now.getDay(),
  };
}

function addDays(ymd: { year: number; month: number; day: number }, days: number) {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function consume(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(Math.max(0, end - start)) + text.slice(end);
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePhone(raw: string): string {
  let value = raw.replace(/plus/gi, "+").replace(/[^\d+]/g, "");
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  if (/^(49|43|41)\d{8,}$/.test(value)) value = `+${value}`;
  return value.startsWith("+") || value.startsWith("0") ? value : raw.trim();
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

function phonesMatch(a: string, b: string): boolean {
  const x = digits(a);
  const y = digits(b);
  if (x.length < 6 || y.length < 6) return false;
  return x === y || x.endsWith(y.slice(-8)) || y.endsWith(x.slice(-8));
}

function wordsOf(name: string): string[] {
  return fold(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w));
}

function nameMatches(displayName: string, query: string): boolean {
  const n = fold(displayName);
  const q = fold(query.trim());
  if (q.length < 2) return false;
  return n === q || wordsOf(displayName).includes(q) || n.startsWith(`${q} `) || n.endsWith(` ${q}`);
}

/** Fuzzy tier: every query word must match some name word, allowing typos and mishearing. */
function nameMatchesFuzzy(displayName: string, query: string): boolean {
  const nameWords = wordsOf(displayName);
  const queryWords = wordsOf(query);
  if (!queryWords.length || !nameWords.length) return false;
  return queryWords.every((q) => nameWords.some((n) => fuzzyWordEquals(n, q)));
}

/**
 * Exact matches win. Only when there is none, fuzzy matches are returned and
 * flagged so callers can ask instead of assigning silently.
 */
function matchByName<T>(items: T[], query: string, nameOf: (item: T) => string): { items: T[]; fuzzy: boolean } {
  const exact = items.filter((item) => nameMatches(nameOf(item), query));
  if (exact.length) return { items: exact, fuzzy: false };
  return { items: items.filter((item) => nameMatchesFuzzy(nameOf(item), query)), fuzzy: true };
}

function customerByPhone(catalog: IntentCatalog, phone: string): IntentCustomer | undefined {
  const hits = catalog.customers.filter((customer) =>
    (customer.phones ?? []).some((entry) => phonesMatch(phone, entry.e164 || entry.raw || "")),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

function uniqueIds<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

function findInText<T extends { id: string }>(
  items: T[],
  text: string,
  nameOf: (item: T) => string,
  options: { fuzzy?: boolean } = {},
): T[] {
  const folded = fold(text);
  const hits: T[] = [];
  for (const item of items) {
    const name = nameOf(item).trim();
    if (!name) continue;
    const candidates = [fold(name), wordsOf(name)[0]].filter((c): c is string => Boolean(c && c.length >= 2));
    for (const candidate of [...new Set(candidates)]) {
      if (new RegExp(`(?:^|[^a-z0-9])${escapeRe(candidate)}(?=[^a-z0-9]|$)`).test(folded)) {
        hits.push(item);
        break;
      }
    }
  }
  // Fuzzy fallback only for non-person catalogs (lesson types, resources): "Tandemflg" -> "Tandemflug".
  if (!hits.length && options.fuzzy) {
    const tokens = folded.split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !STOP.has(t) && !NAME_STOP.has(t));
    for (const item of items) {
      const first = wordsOf(nameOf(item))[0];
      if (!first || first.length < 4) continue;
      if (tokens.some((token) => fuzzyWordEquals(token, first))) hits.push(item);
    }
  }
  return uniqueIds(hits);
}

function stripName(text: string, name: string): string {
  const words = new Set(wordsOf(name));
  if (!words.size) return text;
  return text.replace(/[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\-']*/g, (token) =>
    words.has(fold(token)) ? " ".repeat(token.length) : token,
  );
}

function takePhone(text: string): { phone?: string; rest: string } {
  const labeled =
    /\b(?:telefonnummer|telefon|tel\.?|handy|mobil|nummer)\b\s*[:.]?\s*((?:plus\s*)?\+?[\d\s./-]{6,})/i.exec(text);
  if (labeled) {
    return { phone: normalizePhone(labeled[1]), rest: consume(text, labeled.index, labeled.index + labeled[0].length) };
  }
  const open = /(?:plus\s*)?\+\s*(?:49|43|41)[\d\s./-]{6,}|\b0\d[\d\s./-]{6,}\b/i.exec(text);
  if (!open) return { rest: text };
  return { phone: normalizePhone(open[0]), rest: consume(text, open.index, open.index + open[0].length) };
}

function takeTime(text: string): { time?: string; rest: string } {
  const clock = /\b(?:um\s+)?(\d{1,2})\s*[:.]\s*(\d{2})(?:\s*uhr)?\b/i.exec(text);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    if (h <= 23 && m <= 59) {
      return { time: `${pad(h)}:${pad(m)}`, rest: consume(text, clock.index, clock.index + clock[0].length) };
    }
  }
  const spoken = /\b(?:um\s+)?(\d{1,2})\s*uhr(?:\s*(\d{1,2}))?\b/i.exec(text);
  if (spoken) {
    const h = Number(spoken[1]);
    const m = spoken[2] ? Number(spoken[2]) : 0;
    if (h <= 23 && m <= 59) {
      return { time: `${pad(h)}:${pad(m)}`, rest: consume(text, spoken.index, spoken.index + spoken[0].length) };
    }
  }
  return { rest: text };
}

function takeDuration(text: string): { minutes?: number; rest: string } {
  const min = /\b(\d{1,3})\s*(?:minuten|minute|min)\b/i.exec(text);
  if (min) return { minutes: Number(min[1]), rest: consume(text, min.index, min.index + min[0].length) };
  const half = /\banderthalb\s+stunden?\b/i.exec(text);
  if (half) return { minutes: 90, rest: consume(text, half.index, half.index + half[0].length) };
  const one = /\beine\s+stunde\b/i.exec(text);
  if (one) return { minutes: 60, rest: consume(text, one.index, one.index + one[0].length) };
  const hrs = /\b(\d{1,2})\s*stunden?\b/i.exec(text);
  if (hrs) return { minutes: Number(hrs[1]) * 60, rest: consume(text, hrs.index, hrs.index + hrs[0].length) };
  return { rest: text };
}

function takeDate(text: string, now: Date, timeZone: string): { date?: string; rest: string } {
  const today = zonedToday(now, timeZone);
  let rest = text;
  let date: string | undefined;
  const take = (start: number, end: number, next: { year: number; month: number; day: number }) => {
    if (date) return;
    date = dateKey(next.year, next.month, next.day);
    rest = consume(rest, start, end);
  };

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(rest);
  if (iso) take(iso.index, iso.index + iso[0].length, { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) });

  const num = /\b(\d{1,2})\.\s*(\d{1,2})\.(?:\s*(\d{2,4}))?\b/.exec(rest);
  if (num && !date) {
    const day = Number(num[1]);
    const month = Number(num[2]);
    let year = num[3] ? Number(num[3]) : today.year;
    if (year < 100) year += 2000;
    if (!num[3] && (month < today.month || (month === today.month && day < today.day))) year += 1;
    take(num.index, num.index + num[0].length, { year, month, day });
  }

  // An explicit "16. November" wins over "morgen" even when it comes later ("... Termin ist doch am 16 November").
  const named = new RegExp(`\\b(\\d{1,2})\\.?\\s*(${Object.keys(MONTHS).join("|")})(?:\\s*(\\d{4}))?\\b`, "i").exec(fold(rest));
  if (named && !date) {
    const day = Number(named[1]);
    const month = MONTHS[fold(named[2])];
    let year = named[3] ? Number(named[3]) : today.year;
    if (!named[3] && month < today.month) year += 1;
    if (month) take(named.index, named.index + named[0].length, { year, month, day });
  }

  const rel = [
    { re: /\bheute\b/i, days: 0 },
    { re: /\buebermorgen\b|\bübermorgen\b/i, days: 2 },
    { re: /\bmorgen\b/i, days: 1 },
  ];
  for (const item of rel) {
    const m = item.re.exec(rest);
    if (!m) continue;
    if (!date) take(m.index, m.index + m[0].length, addDays(today, item.days));
    else rest = consume(rest, m.index, m.index + m[0].length);
  }

  const wd = new RegExp(`\\b(${Object.keys(WEEKDAYS).join("|")})\\b`, "i").exec(fold(rest));
  if (wd && !date) {
    const target = WEEKDAYS[fold(wd[1])];
    take(wd.index, wd.index + wd[0].length, addDays(today, (target - today.weekday + 7) % 7));
  }

  return { date, rest };
}

function takeStatus(text: string): { status?: "draft" | "confirmed"; rest: string } {
  const draft = /\b(?:entwurf|vorlaeufig|vorläufig|unverbindlich|bozza|provvisorio)\b/i.exec(text);
  if (draft) return { status: "draft", rest: consume(text, draft.index, draft.index + draft[0].length) };
  const confirmed = /\b(?:bestaetigt|bestätigt|fix|confermato)\b/i.exec(text);
  if (confirmed) return { status: "confirmed", rest: consume(text, confirmed.index, confirmed.index + confirmed[0].length) };
  return { rest: text };
}

const REMINDER_WORDS: Record<string, number> = { einen: 1, ein: 1, eine: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, sieben: 7 };

/** "Erinnerung 2 Tage vorher, Wetterlage checken" -> reminder date relative to the appointment date plus text. */
function takeReminder(text: string, appointmentDate?: string): { date?: string; text?: string; rest: string } {
  const m = /\b(?:erinnerung|erinnere\s+mich|reminder|promemoria)\b\s*[:,]?\s*(?:(\d{1,2}|einen|ein|eine|zwei|drei|vier|fuenf|fünf|sieben)\s+(tage?|wochen?)\s+(?:vorher|davor|zuvor|vor\s+dem\s+termin)|am\s+vortag|einen\s+tag\s+vorher)?\s*[:,]?\s*([^,.;]*)/i.exec(text);
  if (!m) return { rest: text };
  const rest = consume(text, m.index, m.index + m[0].length);
  let days: number | undefined;
  if (m[1] && m[2]) {
    const amount = /^\d+$/.test(m[1]) ? Number(m[1]) : REMINDER_WORDS[fold(m[1])] ?? 1;
    days = /woche/i.test(m[2]) ? amount * 7 : amount;
  } else if (/vortag|einen\s+tag\s+vorher/i.test(m[0])) {
    days = 1;
  }
  const reminderText = (m[3] ?? "").trim().replace(/\s+/g, " ") || undefined;
  if (days === undefined || !appointmentDate) return { text: reminderText, rest };
  const [y, mo, d] = appointmentDate.split("-").map(Number);
  if (!y || !mo || !d) return { text: reminderText, rest };
  const next = addDays({ year: y, month: mo, day: d }, -days);
  return { date: dateKey(next.year, next.month, next.day), text: reminderText, rest };
}

function validDate(value: string | null | undefined): string | undefined {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function validTime(value: string | null | undefined): string | undefined {
  if (!value || !/^\d{1,2}:\d{1,2}$/.test(value)) return undefined;
  const [h, m] = value.split(":").map(Number);
  return h !== undefined && m !== undefined && h <= 23 && m <= 59 ? `${pad(h)}:${pad(m)}` : undefined;
}

function titleName(parts: string[]): string {
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

function takeLabeledName(text: string, pattern: RegExp): { name?: string; rest: string } {
  const match = pattern.exec(text);
  if (!match) return { rest: text };
  const after = text.slice(match.index + match[0].length);
  const tokenRe = /[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\-']*/g;
  const picked: string[] = [];
  let end = match.index + match[0].length;
  let cursor = 0;
  let skipped = 0;
  let token: RegExpExecArray | null;
  while ((token = tokenRe.exec(after))) {
    if (token.index - cursor > 12) break;
    const folded = fold(token[0]);
    cursor = token.index + token[0].length;
    if (folded.length < 2 || NAME_STOP.has(folded) || STOP.has(folded)) {
      skipped += 1;
      if (skipped > 3 || picked.length) break;
      continue;
    }
    picked.push(token[0]);
    end = match.index + match[0].length + token.index + token[0].length;
    if (picked.length >= 3) break;
  }
  if (!picked.length) {
    return { rest: consume(text, match.index, match.index + match[0].length) };
  }
  return { name: titleName(picked), rest: consume(text, match.index, end) };
}

function leftoverPersonName(text: string, excludeNames: string[]): string | undefined {
  const excluded = new Set(excludeNames.flatMap((name) => wordsOf(name)));
  const tokens = text.match(/[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß\-']*/g) ?? [];
  const picked: string[] = [];
  for (const token of tokens) {
    const folded = fold(token);
    if (
      folded.length < 2 ||
      STOP.has(folded) ||
      NAME_STOP.has(folded) ||
      excluded.has(folded) ||
      /^\d+$/.test(folded)
    ) {
      continue;
    }
    picked.push(token);
    if (picked.length >= 3) break;
  }
  return picked.length ? titleName(picked) : undefined;
}

function resolveCustomer(
  parsed: ParsedAppointmentIntent,
  catalog: IntentCatalog,
  rest: string,
  questions: ClarifyingQuestion[],
  fieldConfidence: Record<string, number>,
): string {
  if (!parsed.customerName) {
    const teacherWords = new Set(parsed.teacherName ? wordsOf(parsed.teacherName) : []);
    const hits = findInText(catalog.customers, rest, (item) => item.displayName).filter((customer) => {
      const words = wordsOf(customer.displayName);
      return words.some((word) => !teacherWords.has(word));
    });
    if (hits.length === 1) {
      parsed.customerId = hits[0].id;
      parsed.customerName = hits[0].displayName;
      parsed.createCustomer = false;
      fieldConfidence.customerId = 0.88;
      return stripName(rest, hits[0].displayName);
    }
    if (hits.length > 1) {
      questions.push({
        id: "customer",
        prompt: "Welcher Passagier ist gemeint?",
        options: hits.slice(0, 5).map((item) => ({ value: item.id, label: item.displayName })),
      });
    }
  }

  if (!parsed.customerName) {
    const leftover = leftoverPersonName(rest, [
      parsed.teacherName ?? "",
      parsed.lessonTypeName ?? "",
      parsed.resourceName ?? "",
      ...catalog.teachers.map((item) => item.displayName),
      ...catalog.lessonTypes.map((item) => item.displayName),
      ...catalog.resources.map((item) => item.name),
    ]);
    if (leftover) {
      parsed.customerName = leftover;
      fieldConfidence.customerName = 0.72;
      rest = stripName(rest, leftover);
    }
  }

  if (parsed.phone && !parsed.customerId && !parsed.customerName) {
    const byPhone = customerByPhone(catalog, parsed.phone);
    if (byPhone) {
      parsed.customerId = byPhone.id;
      parsed.customerName = byPhone.displayName;
      parsed.createCustomer = false;
      fieldConfidence.customerId = 0.9;
    }
  }

  if (parsed.customerName) {
    const { items: hits, fuzzy } = matchByName(catalog.customers, parsed.customerName, (customer) => customer.displayName);
    if (hits.length === 1 && !fuzzy) {
      parsed.customerId = hits[0].id;
      parsed.customerName = hits[0].displayName;
      parsed.createCustomer = false;
      fieldConfidence.customerId = 0.9;
      rest = stripName(rest, hits[0].displayName);
    } else if (hits.length >= 1) {
      // Similar names (typo, mishearing) are never assigned silently: ask, default to a new customer.
      if (fuzzy) {
        parsed.createCustomer = true;
        fieldConfidence.customerId = 0.6;
      }
      questions.push(customerQuestion(parsed.customerName, hits, fuzzy));
    } else {
      parsed.createCustomer = true;
      parsed.customerId = undefined;
      fieldConfidence.customerId = 0.8;
    }
  }

  return rest;
}

function dropQuestion(questions: ClarifyingQuestion[], id: string) {
  const index = questions.findIndex((q) => q.id === id);
  if (index >= 0) questions.splice(index, 1);
}

/**
 * Staff mentioned in free text without ambiguity: full name present, or a first
 * name that only one staff member has. Shared first names ("Martin") are skipped.
 */
function unambiguousTeachers(teachers: IntentEntity[], text: string): IntentEntity[] {
  const folded = fold(text);
  const present = (candidate: string) =>
    new RegExp(`(?:^|[^a-z0-9])${escapeRe(candidate)}(?=[^a-z0-9]|$)`).test(folded);
  const hits = findInText(teachers, text, (item) => item.displayName);
  const firstWordCount = new Map<string, number>();
  for (const item of hits) {
    const first = wordsOf(item.displayName)[0] ?? "";
    firstWordCount.set(first, (firstWordCount.get(first) ?? 0) + 1);
  }
  return hits.filter((item) => {
    if (present(fold(item.displayName))) return true;
    const first = wordsOf(item.displayName)[0] ?? "";
    return first.length >= 2 && firstWordCount.get(first) === 1;
  });
}

/** Append a staff member; the first one also fills the legacy single teacherId/teacherName. */
function addTeacher(
  parsed: ParsedAppointmentIntent,
  teacher: IntentEntity,
  fieldConfidence: Record<string, number>,
  confidence: number,
) {
  const ids = parsed.teacherIds ?? (parsed.teacherId ? [parsed.teacherId] : []);
  const names = parsed.teacherNames ?? (parsed.teacherName ? [parsed.teacherName] : []);
  if (!ids.includes(teacher.id)) {
    ids.push(teacher.id);
    names.push(teacher.displayName);
  }
  parsed.teacherIds = ids;
  parsed.teacherNames = names;
  if (!parsed.teacherId) {
    parsed.teacherId = teacher.id;
    parsed.teacherName = teacher.displayName;
  }
  fieldConfidence.teacherId = Math.max(fieldConfidence.teacherId ?? 0, confidence);
}

function customerQuestion(name: string, hits: IntentCustomer[], fuzzy: boolean): ClarifyingQuestion {
  return {
    id: "customer",
    prompt: fuzzy ? `Ist „${name}“ ein bestehender Passagier?` : `Welcher Passagier „${name}“ ist gemeint?`,
    options: [
      ...hits.slice(0, 4).map((item) => ({ value: item.id, label: item.displayName })),
      { value: "new", label: `Neu anlegen: ${name}` },
    ],
  };
}

/** Apply answers to earlier clarifying questions; shared by the rule parser and the AI path. */
function applyAnswers(
  parsed: ParsedAppointmentIntent,
  catalog: IntentCatalog,
  questions: ClarifyingQuestion[],
  fieldConfidence: Record<string, number>,
  answers: Record<string, string>,
) {
  const teacherAnswer = answers.teacher || answers.teacherId;
  if (teacherAnswer) {
    const teacher = catalog.teachers.find((t) => t.id === teacherAnswer);
    if (teacher) {
      addTeacher(parsed, teacher, fieldConfidence, 1);
      dropQuestion(questions, "teacher");
    }
  }
  const lessonAnswer = answers.lessonType || answers.lessonTypeId;
  if (lessonAnswer) {
    const lesson = catalog.lessonTypes.find((t) => t.id === lessonAnswer);
    if (lesson) {
      parsed.lessonTypeId = lesson.id;
      parsed.lessonTypeName = lesson.displayName;
      fieldConfidence.lessonTypeId = 1;
      dropQuestion(questions, "lessonType");
    }
  }
  const customerAnswer = answers.customer || answers.customerId;
  if (customerAnswer === "new") {
    parsed.customerId = undefined;
    parsed.createCustomer = true;
    fieldConfidence.customerId = 1;
    dropQuestion(questions, "customer");
  } else if (customerAnswer) {
    const customer = catalog.customers.find((c) => c.id === customerAnswer);
    if (customer) {
      parsed.customerId = customer.id;
      parsed.customerName = customer.displayName;
      parsed.createCustomer = false;
      fieldConfidence.customerId = 1;
      dropQuestion(questions, "customer");
    }
  }
}

/** Field values as produced by the AI model (names as text, no IDs). */
export interface ExtractedIntent {
  contactText: string;
  date?: string | null;
  time?: string | null;
  durationMinutes?: number | null;
  teacherName?: string | null;
  teacherNames?: string[] | null;
  lessonTypeName?: string | null;
  resourceName?: string | null;
  customerName?: string | null;
  customerNames?: string[] | null;
  status?: string | null;
  reminderDate?: string | null;
  reminderTime?: string | null;
  reminderText?: string | null;
  phone?: string | null;
  note?: string | null;
}

/**
 * Turn an AI extraction into the same result shape as the rule parser: validate
 * values and resolve names against the tenant catalog (exact first, fuzzy with a question).
 */
export function resolveExtractedIntent(
  extraction: ExtractedIntent,
  catalog: IntentCatalog,
  answers: Record<string, string> = {},
): ParseIntentResult {
  const parsed: ParsedAppointmentIntent = { contactText: extraction.contactText.replace(/\s+/g, " ").trim() };
  const fieldConfidence: Record<string, number> = {};
  const questions: ClarifyingQuestion[] = [];

  const date = validDate(extraction.date);
  if (date) {
    parsed.date = date;
    fieldConfidence.date = 0.9;
  }
  const time = validTime(extraction.time);
  if (time) {
    parsed.time = time;
    fieldConfidence.time = 0.9;
  }
  if (extraction.status === "draft" || extraction.status === "confirmed") {
    parsed.status = extraction.status;
  }
  const reminderDate = validDate(extraction.reminderDate);
  const reminderText = extraction.reminderText?.trim();
  if (reminderDate || reminderText) {
    parsed.reminderDate = reminderDate;
    parsed.reminderTime = validTime(extraction.reminderTime);
    parsed.reminderText = reminderText || undefined;
    // A reminder only exists for drafts in this app.
    if (!parsed.status) parsed.status = "draft";
    fieldConfidence.reminderDate = reminderDate ? 0.85 : 0;
  }
  const duration = extraction.durationMinutes;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0 && duration <= 24 * 60) {
    parsed.durationMinutes = Math.round(duration);
    fieldConfidence.durationMinutes = 0.85;
  }
  if (extraction.phone?.trim()) {
    const phone = normalizePhone(extraction.phone);
    if (digits(phone).length >= 6) {
      parsed.phone = phone;
      fieldConfidence.phone = 0.85;
    }
  }

  const teacherQueries = [...(extraction.teacherNames ?? []), extraction.teacherName ?? ""]
    .map((name) => name.trim())
    .filter((name, index, all) => name && all.indexOf(name) === index);
  for (const teacherQuery of teacherQueries) {
    const { items, fuzzy } = matchByName(catalog.teachers, teacherQuery, (item) => item.displayName);
    const single = items.length === 1 ? items[0] : undefined;
    if (single) {
      addTeacher(parsed, single, fieldConfidence, fuzzy ? 0.75 : 0.9);
    } else if (items.length > 1 && !questions.some((q) => q.id === "teacher")) {
      questions.push({
        id: "teacher",
        prompt: `Welcher „${catalog.teacherLabel}“ ist mit „${teacherQuery}“ gemeint?`,
        options: items.slice(0, 5).map((item) => ({ value: item.id, label: item.displayName })),
      });
    }
  }

  const lessonQuery = extraction.lessonTypeName?.trim();
  if (lessonQuery) {
    const { items, fuzzy } = matchByName(catalog.lessonTypes, lessonQuery, (item) => item.displayName);
    const single = items.length === 1 ? items[0] : undefined;
    if (single) {
      parsed.lessonTypeId = single.id;
      parsed.lessonTypeName = single.displayName;
      fieldConfidence.lessonTypeId = fuzzy ? 0.75 : 0.9;
    } else if (items.length > 1) {
      questions.push({
        id: "lessonType",
        prompt: "Welche Terminart ist gemeint?",
        options: items.slice(0, 5).map((item) => ({ value: item.id, label: item.displayName })),
      });
    }
  }

  const resourceQuery = extraction.resourceName?.trim();
  if (resourceQuery) {
    const { items, fuzzy } = matchByName(catalog.resources, resourceQuery, (item) => item.name);
    const single = items.length === 1 ? items[0] : undefined;
    if (single) {
      parsed.resourceId = single.id;
      parsed.resourceName = single.name;
      fieldConfidence.resourceId = fuzzy ? 0.7 : 0.85;
    }
  }

  const customerList = [...(extraction.customerNames ?? []), extraction.customerName ?? ""]
    .map((name) => name.trim())
    .filter((name, index, all) => name && all.indexOf(name) === index);
  const customerQuery = customerList[0];
  if (customerList.length > 1) parsed.additionalCustomerNames = customerList.slice(1);
  if (customerQuery) {
    const { items, fuzzy } = matchByName(catalog.customers, customerQuery, (item) => item.displayName);
    const single = items.length === 1 ? items[0] : undefined;
    if (single && !fuzzy) {
      parsed.customerId = single.id;
      parsed.customerName = single.displayName;
      parsed.createCustomer = false;
      fieldConfidence.customerId = 0.9;
    } else if (items.length >= 1) {
      parsed.customerName = customerQuery;
      parsed.createCustomer = true;
      fieldConfidence.customerId = 0.6;
      questions.push(customerQuestion(customerQuery, items, fuzzy));
    } else {
      parsed.customerName = customerQuery;
      parsed.createCustomer = true;
      fieldConfidence.customerId = 0.8;
      fieldConfidence.customerName = 0.85;
    }
  } else if (parsed.phone) {
    const byPhone = customerByPhone(catalog, parsed.phone);
    if (byPhone) {
      parsed.customerId = byPhone.id;
      parsed.customerName = byPhone.displayName;
      parsed.createCustomer = false;
      fieldConfidence.customerId = 0.9;
    }
  }

  const noteParts = [extraction.note?.trim() ?? ""];
  if (parsed.additionalCustomerNames?.length) {
    noteParts.push(`Weitere Passagiere: ${parsed.additionalCustomerNames.join(", ")}`);
  }
  const note = noteParts.filter(Boolean).join(" · ");
  if (note) parsed.note = note;

  applyAnswers(parsed, catalog, questions, fieldConfidence, answers);

  return {
    parsed,
    fieldConfidence,
    clarifyingQuestions: questions.slice(0, 3),
    suggestedDefaults: {},
  };
}

export function parseAppointmentIntent(
  rawText: string,
  catalog: IntentCatalog,
  answers: Record<string, string> = {},
): ParseIntentResult {
  const original = rawText.replace(/\s+/g, " ").trim();
  const parsed: ParsedAppointmentIntent = { contactText: original };
  const fieldConfidence: Record<string, number> = {};
  const questions: ClarifyingQuestion[] = [];
  const now = catalog.now ?? new Date();
  let rest = original.replace(/\bplus\b/gi, "+");

  const phone = takePhone(rest);
  rest = phone.rest;
  if (phone.phone) {
    parsed.phone = phone.phone;
    fieldConfidence.phone = 0.9;
  }

  const date = takeDate(rest, now, catalog.timeZone);
  rest = date.rest;
  if (date.date) {
    parsed.date = date.date;
    fieldConfidence.date = 0.95;
  }

  const time = takeTime(rest);
  rest = time.rest;
  if (time.time) {
    parsed.time = time.time;
    fieldConfidence.time = 0.93;
  }

  const duration = takeDuration(rest);
  rest = duration.rest;
  if (duration.minutes) {
    parsed.durationMinutes = duration.minutes;
    fieldConfidence.durationMinutes = 0.9;
  }

  const status = takeStatus(rest);
  rest = status.rest;
  if (status.status) parsed.status = status.status;

  const reminder = takeReminder(rest, parsed.date);
  rest = reminder.rest;
  if (reminder.date || reminder.text) {
    parsed.reminderDate = reminder.date;
    parsed.reminderText = reminder.text;
    if (!parsed.status) parsed.status = "draft";
    fieldConfidence.reminderDate = reminder.date ? 0.85 : 0;
  }

  const passenger = takeLabeledName(rest, PASSENGER_RE);
  rest = passenger.rest;
  if (passenger.name) {
    parsed.customerName = passenger.name;
    fieldConfidence.customerName = 0.86;
  }

  const roles = [catalog.teacherLabel, "lehrer", "lehrerin", "pilot", "pilotin", "fluglehrer", "trainer"]
    .map((label) => fold(label).trim())
    .filter((label, i, all) => label && all.indexOf(label) === i);
  const teacherLabel = takeLabeledName(rest, new RegExp(`\\b(?:${roles.map(escapeRe).join("|")})\\b`, "i"));
  rest = teacherLabel.rest;

  const lessonHits = findInText(catalog.lessonTypes, rest, (item) => item.displayName, { fuzzy: true });
  if (lessonHits.length === 1) {
    parsed.lessonTypeId = lessonHits[0].id;
    parsed.lessonTypeName = lessonHits[0].displayName;
    fieldConfidence.lessonTypeId = 0.9;
    rest = stripName(rest, lessonHits[0].displayName);
  } else if (lessonHits.length > 1) {
    questions.push({
      id: "lessonType",
      prompt: "Welche Terminart ist gemeint?",
      options: lessonHits.slice(0, 5).map((item) => ({ value: item.id, label: item.displayName })),
    });
  }

  const resourceHits = findInText(
    catalog.resources.map((item) => ({ id: item.id, displayName: item.name })),
    rest,
    (item) => item.displayName,
    { fuzzy: true },
  );
  if (resourceHits.length === 1) {
    parsed.resourceId = resourceHits[0].id;
    parsed.resourceName = resourceHits[0].displayName;
    fieldConfidence.resourceId = 0.85;
    rest = stripName(rest, resourceHits[0].displayName);
  }

  const labeledTeacher = teacherLabel.name
    ? matchByName(catalog.teachers, teacherLabel.name, (item) => item.displayName)
    : null;
  const teacherHits = labeledTeacher
    ? labeledTeacher.items
    : findInText(catalog.teachers, rest, (item) => item.displayName);
  const onlyTeacher = teacherHits.length === 1 ? teacherHits[0] : undefined;
  if (onlyTeacher) {
    addTeacher(parsed, onlyTeacher, fieldConfidence, labeledTeacher ? (labeledTeacher.fuzzy ? 0.75 : 0.92) : 0.82);
    rest = stripName(rest, onlyTeacher.displayName);
    // "Pilot Sepp und Martin Huber": further staff named alongside the labeled one join the appointment.
    if (labeledTeacher) {
      for (const extra of unambiguousTeachers(catalog.teachers, rest)) {
        if (extra.id === parsed.teacherId) continue;
        addTeacher(parsed, extra, fieldConfidence, 0.8);
        rest = stripName(rest, extra.displayName);
      }
    }
  } else if (teacherHits.length > 1) {
    // "Pilot Martin und Martin Gasser": assign the fully named one, ask about the bare first name.
    if (labeledTeacher) {
      for (const extra of unambiguousTeachers(catalog.teachers, rest)) {
        addTeacher(parsed, extra, fieldConfidence, 0.8);
        rest = stripName(rest, extra.displayName);
      }
    }
    questions.push({
      id: "teacher",
      prompt: `Welcher „${teacherLabel.name || catalog.teacherLabel}“ ist gemeint?`,
      options: teacherHits.slice(0, 5).map((item) => ({ value: item.id, label: item.displayName })),
    });
  }

  rest = resolveCustomer(parsed, catalog, rest, questions, fieldConfidence);

  applyAnswers(parsed, catalog, questions, fieldConfidence, answers);

  // Keep only segments with real content; drop filler left behind by consumed fields ("Termin ist doch am ,").
  const isFiller = (t: string) => !t || STOP.has(t) || NAME_STOP.has(t) || t.length <= 1;
  const segments = rest
    .split(/[,.;]+/)
    .map((segment) => segment.replace(/\s+/g, " ").trim())
    .map((segment) => {
      const words = segment.split(" ");
      while (words.length && isFiller(fold(words[0]!.replace(/[^\p{L}\p{N}-]+/gu, "")))) words.shift();
      return words.join(" ");
    })
    .filter((segment) =>
      segment.split(" ").some((t) => !isFiller(fold(t.replace(/[^\p{L}\p{N}-]+/gu, "")))),
    );
  if (segments.length) parsed.note = segments.join(", ");

  return {
    parsed,
    fieldConfidence,
    clarifyingQuestions: questions.slice(0, 3),
    suggestedDefaults: {},
  };
}
