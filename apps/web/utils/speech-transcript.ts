function normalizeSpeech(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isLastWordCorrection(last: string, incoming: string): boolean {
  const a = last.toLowerCase();
  const b = incoming.toLowerCase();
  if (!a || !b || a === b) return a === b;
  if (b.startsWith(a) && b.length > a.length && a.length >= 3) return true;
  if (a.startsWith(b) && a.length - b.length <= 2 && b.length >= 3) return true;
  return false;
}

function tailHeadOverlap(left: string[], right: string[]): number {
  const max = Math.min(left.length, right.length, 4);
  for (let count = max; count >= 1; count -= 1) {
    const tail = left.slice(-count).join(" ").toLowerCase();
    const head = right.slice(0, count).join(" ").toLowerCase();
    if (tail === head) return count;
  }
  return 0;
}

/**
 * Merge a finished utterance into committed dictation. Never shrinks the base,
 * never replaces it with a later snapshot.
 */
export function commitUtterance(base: string, utterance: string): string {
  const committed = normalizeSpeech(base);
  const incoming = normalizeSpeech(utterance);
  if (!incoming) return committed;
  if (!committed) return incoming;

  const committedLc = committed.toLowerCase();
  const incomingLc = incoming.toLowerCase();
  if (incomingLc === committedLc) return committed;
  if (incomingLc.startsWith(`${committedLc} `)) return incoming;
  if (committedLc.endsWith(` ${incomingLc}`) || committedLc.startsWith(`${incomingLc} `)) return committed;
  if (committedLc.includes(` ${incomingLc} `)) return committed;

  const committedWords = committed.split(" ");
  const incomingWords = incoming.split(" ");
  const lastWord = committedWords[committedWords.length - 1] ?? "";
  if (incomingWords.length === 1 && isLastWordCorrection(lastWord, incoming)) {
    committedWords[committedWords.length - 1] = incoming;
    return committedWords.join(" ");
  }

  const overlap = tailHeadOverlap(committedWords, incomingWords);
  if (overlap > 0) {
    return [...committedWords, ...incomingWords.slice(overlap)].join(" ");
  }
  return `${committed} ${incoming}`;
}

/** Show live words on top of committed text without wiping the base. */
export function withLiveInterim(base: string, interim: string): string {
  const committed = normalizeSpeech(base);
  const live = normalizeSpeech(interim);
  if (!live) return committed;
  if (!committed) return live;

  const committedLc = committed.toLowerCase();
  const liveLc = live.toLowerCase();
  if (liveLc === committedLc) return committed;
  if (liveLc.startsWith(`${committedLc} `)) return live;
  if (committedLc.endsWith(` ${liveLc}`) || committedLc.startsWith(`${liveLc} `)) return committed;
  if (committedLc.includes(` ${liveLc} `)) return committed;

  const committedWords = committed.split(" ");
  const liveWords = live.split(" ");
  const overlap = tailHeadOverlap(committedWords, liveWords);
  if (overlap > 0) {
    return [...committedWords, ...liveWords.slice(overlap)].join(" ");
  }
  return `${committed} ${live}`;
}

export function spokenFromRecognition(finals: string[], lastInterim: string): string {
  const committed = finals.reduce((text, part) => commitUtterance(text, part), "");
  return withLiveInterim(committed, lastInterim);
}

function speechWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
}

/**
 * Choose between recognizer alternatives: the one mentioning the most known names
 * (staff, customers, appointment types) wins; ties keep the recognizer's first choice.
 */
export function pickTranscript(primary: string, alternatives?: string[], hints?: string[]): string {
  const candidates = [primary, ...(alternatives ?? [])].map(normalizeSpeech).filter(Boolean);
  const first = candidates[0] ?? "";
  if (!first) return "";
  if (candidates.length === 1 || !hints?.length) return first;
  const hintWords = new Set(hints.flatMap(speechWords));
  if (!hintWords.size) return first;
  let best = first;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = speechWords(candidate).filter((word) => hintWords.has(word)).length;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
