/**
 * Fuzzy matching for German/Italian person and catalog names.
 * Used to map dictated or misspelled names ("Maier" vs "Meyer") onto catalog entries.
 */

export function fold(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/ß/g, "ss")
    .replace(/[äÄ]/g, "ae")
    .replace(/[öÖ]/g, "oe")
    .replace(/[üÜ]/g, "ue")
    .toLowerCase();
}

/** Kölner Phonetik (Postel 1969): same code for Maier, Mayer, Meier, Meyer. */
export function colognePhonetic(input: string): string {
  const word = fold(input).replace(/[^a-z]/g, "");
  if (!word) return "";
  const codes: string[] = [];
  const at = (i: number) => word[i] ?? "";
  for (let i = 0; i < word.length; i += 1) {
    const ch = at(i);
    const prev = at(i - 1);
    const next = at(i + 1);
    let code = "";
    switch (ch) {
      case "a": case "e": case "i": case "j": case "o": case "u": case "y":
        code = "0";
        break;
      case "h":
        code = "-";
        break;
      case "b":
        code = "1";
        break;
      case "p":
        code = next === "h" ? "3" : "1";
        break;
      case "d": case "t":
        code = "csz".includes(next) && next ? "8" : "2";
        break;
      case "f": case "v": case "w":
        code = "3";
        break;
      case "g": case "k": case "q":
        code = "4";
        break;
      case "c":
        if (i === 0) {
          code = "ahkloqrux".includes(next) && next ? "4" : "8";
        } else if (prev === "s" || prev === "z") {
          code = "8";
        } else {
          code = "ahkoqux".includes(next) && next ? "4" : "8";
        }
        break;
      case "x":
        code = "ckq".includes(prev) && prev ? "8" : "48";
        break;
      case "l":
        code = "5";
        break;
      case "m": case "n":
        code = "6";
        break;
      case "r":
        code = "7";
        break;
      case "s": case "z":
        code = "8";
        break;
      default:
        code = "";
    }
    codes.push(code);
  }
  const raw = codes.join("");
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === "-") continue;
    if (c === out[out.length - 1]) continue;
    out += c;
  }
  // Keep a leading 0, drop all other vowels.
  return out.length ? out[0] + out.slice(1).replace(/0/g, "") : "";
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * True when two single words are the same name allowing for typos and mishearing.
 * Short words (< 4 letters) must match exactly; the tolerance grows with length.
 */
export function fuzzyWordEquals(a: string, b: string): boolean {
  const x = fold(a).replace(/[^a-z0-9]/g, "");
  const y = fold(b).replace(/[^a-z0-9]/g, "");
  if (!x || !y) return false;
  if (x === y) return true;
  const len = Math.min(x.length, y.length);
  if (len < 4) return false;
  const distance = levenshtein(x, y);
  const allowed = len >= 8 ? 2 : len >= 5 ? 1 : 0;
  if (distance <= allowed) return true;
  return distance <= 2 && colognePhonetic(x) === colognePhonetic(y);
}
