// Offline proofreader: Hunspell spelling dictionary + hand-written rules for the
// mistakes that matter most on printed material. No network, no account.
import nspell from "nspell";
import type { Issue, ProofResult, Severity } from "./proof";

type NSpell = ReturnType<typeof nspell>;
let spellPromise: Promise<NSpell> | null = null;

function loadSpeller(): Promise<NSpell> {
  spellPromise ??= (async () => {
    const [aff, dic] = await Promise.all([
      fetch("./vendor/dict/en.aff").then((r) => r.text()),
      fetch("./vendor/dict/en.dic").then((r) => r.text()),
    ]);
    const spell = nspell(aff, dic);
    // Common words on flyers, menus and ads that the base dictionary lacks.
    for (const w of EXTRA_WORDS) spell.add(w);
    return spell;
  })();
  return spellPromise;
}

const EXTRA_WORDS = [
  "ok", "okay", "email", "emails", "online", "website", "websites", "app", "apps", "wifi", "wi-fi",
  "Instagram", "Facebook", "TikTok", "YouTube", "Google", "iPhone", "Android", "Venmo", "Zelle", "PayPal",
  "BOGO", "RSVP", "FAQ", "FAQs", "LLC", "Inc", "St", "Ave", "Blvd", "Rd", "Ste", "pm", "am", "AM", "PM",
  "hr", "hrs", "min", "mins", "qty", "pcs", "lbs", "oz", "vs", "etc", "e.g", "i.e", "ASAP", "USA", "US",
  "gluten", "vegan", "keto", "barbecue", "BBQ", "takeout", "catering", "espresso", "latte", "cappuccino",
  "signup", "login", "checkout", "preorder", "pre-order", "eco", "DIY", "UV", "LED", "HVAC",
];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const monthIdx = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().replace(".", "").slice(0, 3)));
const dayIdx = (s: string) => DAYS.findIndex((d) => d.startsWith(s.toLowerCase().slice(0, 3)));

export interface OfflineOptions {
  notes: string;
  /** Also ask LanguageTool's free public API for grammar (sends text to languagetool.org). */
  languageTool: boolean;
}

export async function proofreadOffline(text: string, opts: OfflineOptions): Promise<ProofResult> {
  const spell = await loadSpeller();
  // Every word in the user's notes is treated as correct (names, brands, house terms).
  for (const w of opts.notes.match(/[A-Za-z][A-Za-z'’-]+/g) ?? []) spell.add(w.replace(/[’]/g, "'"));

  const issues: Issue[] = [];
  const add = (severity: Severity, category: string, original: string, suggestion: string, explanation: string, location = "") => {
    if (!issues.some((i) => i.original === original && i.category === category)) {
      issues.push({ severity, category, original, suggestion, explanation, location });
    }
  };
  const lineOf = (needle: string) => {
    const idx = text.split("\n").findIndex((l) => l.includes(needle));
    return idx >= 0 ? `line ${idx + 1}` : "";
  };

  checkSpelling(text, spell, add, lineOf);
  checkWordRules(text, add, lineOf);
  checkDates(text, add, lineOf);
  checkContacts(text, add, lineOf);
  checkPunctuation(text, add, lineOf);
  checkConsistency(text, add);

  if (opts.languageTool) {
    try {
      for (const i of await languageTool(text)) {
        if (!issues.some((x) => x.original === i.original)) issues.push(i);
      }
    } catch {
      add("suggestion", "clarity", "", "", "The online grammar check (LanguageTool) couldn't be reached, so only offline checks ran.");
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const lines = text.split("\n").filter((l) => l.trim()).length;
  const summary = !text.trim()
    ? "No text was found in the image. Try a sharper, closer photo."
    : `Read ${lines} line${lines === 1 ? "" : "s"} on this phone and checked spelling, grammar, dates, phone numbers, emails and links.${opts.languageTool ? " Grammar also checked online." : ""}`;

  let corrected = text;
  for (const i of issues) {
    if (i.severity === "error" && i.original && i.suggestion && i.suggestion !== "?" && !i.suggestion.includes(" or ")) {
      corrected = corrected.split(i.original).join(i.suggestion);
    }
  }
  return { transcription: text, summary, issues, corrected_text: corrected };
}

/** Words not in the dictionary that look like names: brands, tools, products (e.g. “Midjourney”, “ChatGPT”). */
export async function likelyNames(text: string): Promise<string[]> {
  const spell = await loadSpeller();
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*\b/g)) {
    const w = m[0];
    if (w.length < 3 || !/[A-Z]/.test(w) || /^[A-Z]{2,4}$/.test(w) || /^[A-Z]+\d+$/.test(w)) continue;
    if (spell.correct(w) || spell.correct(w.toLowerCase())) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 40);
}

type Add = (s: Severity, c: string, o: string, sug: string, e: string, loc?: string) => void;

function checkSpelling(text: string, spell: NSpell, add: Add, lineOf: (s: string) => string) {
  const urlish = /\S+@\S+|\b(?:https?:\/\/|www\.)\S+|\S+\.(?:com|net|org|io|co)\S*/gi;
  const clean = text.replace(urlish, " ");
  for (const m of clean.matchAll(/[A-Za-z][A-Za-z'’]*[A-Za-z]|[A-Za-z]/g)) {
    let word = m[0].replace(/’/g, "'");
    if (word.length < 3) continue;
    const before = clean.slice(Math.max(0, m.index! - 1), m.index!);
    const after = clean[m.index! + m[0].length] ?? "";
    if (/\d/.test(before) || /\d/.test(after) || after === "@" || before === "@" || before === "#") continue;
    word = word.replace(/'s$/i, "");
    if (spell.correct(word)) continue;
    const lower = word.toLowerCase();
    if (spell.correct(lower)) continue;
    // ALL CAPS headline words: check the lower-case form.
    let sugs = rankSuggestions(lower, spell.suggest(word === word.toUpperCase() ? lower : word));
    // “pastrys” → “pastries”: a plural written with -ys
    const ies = lower.replace(/ys$/, "ies");
    if (ies !== lower && spell.correct(ies)) sugs = [ies, ...sugs.filter((x) => x.toLowerCase() !== ies)];
    const fix = sugs[0] ? matchCase(word, sugs[0]) : "";
    const isName = /^[A-Z][a-z]/.test(word) && m.index! > 0 && !/[.!?]\s*$/.test(clean.slice(0, m.index!).trimEnd().slice(-2));
    if (isName) {
      add("warning", "spelling", word, fix || word, "Not in the dictionary. If this is a name or brand, make sure it's spelled the way you want (add it to your notes to stop this warning).", lineOf(m[0]));
    } else {
      add("error", "spelling", word, fix || "?", fix ? `Possible misspelling.${sugs.length > 1 ? ` Other options: ${sugs.slice(1, 3).join(", ")}.` : ""}` : "Not a recognized word.", lineOf(m[0]));
    }
  }
}

// Frequent real-world misspellings, checked before the dictionary's own guesses.
const COMMON: Record<string, string> = {
  suprise: "surprise", recieve: "receive", seperate: "separate", definately: "definitely", occured: "occurred",
  accomodate: "accommodate", untill: "until", wierd: "weird", tommorow: "tomorrow", tommorrow: "tomorrow",
  calender: "calendar", resturant: "restaurant", restaraunt: "restaurant", guarentee: "guarantee", adress: "address",
  buisness: "business", bussiness: "business", comming: "coming", begining: "beginning", beleive: "believe",
  existance: "existence", neccessary: "necessary", necesary: "necessary", occassion: "occasion", refered: "referred",
  sucess: "success", truely: "truly", writting: "writing", appetizor: "appetizer",   liason: "liaison", millenium: "millennium", noticable: "noticeable", posession: "possession", publically: "publicly",
  reccomend: "recommend", recomend: "recommend", relevent: "relevant", rythm: "rhythm", tounge: "tongue",
  wensday: "Wednesday", febuary: "February", thier: "their", alright: "all right", greatful: "grateful",
  independant: "independent", maintainance: "maintenance", mispell: "misspell", embarass: "embarrass",
  occurence: "occurrence", persistant: "persistent", priviledge: "privilege", questionaire: "questionnaire",
  reciept: "receipt", sieze: "seize", supercede: "supersede", threshhold: "threshold", vaccum: "vacuum",
  carribean: "Caribbean", cemetary: "cemetery", collegue: "colleague", concious: "conscious", enviroment: "environment",
  goverment: "government", harrass: "harass", immediatly: "immediately", jewelery: "jewelry", knowlege: "knowledge",
  lisence: "license", liscense: "license", manuever: "maneuver", mischievious: "mischievous", occuring: "occurring",
  pasttime: "pastime", perseverence: "perseverance", playwrite: "playwright", prefered: "preferred", sargent: "sergeant",
  temperture: "temperature", tomatos: "tomatoes", potatos: "potatoes", wether: "whether", experiance: "experience",
  apparant: "apparent", arguement: "argument", catagory: "category", completly: "completely", convienient: "convenient",
  definitly: "definitely", dissapoint: "disappoint", excellant: "excellent", finaly: "finally", foriegn: "foreign",
  happend: "happened", interupt: "interrupt", libary: "library", lollypop: "lollipop", minature: "miniature",
  oppurtunity: "opportunity", opportunty: "opportunity", particulary: "particularly", realy: "really", remeber: "remember",
  sandwhich: "sandwich", scedule: "schedule", shedule: "schedule", specialy: "specially", statment: "statement",
  succesful: "successful", successfull: "successful", tatoo: "tattoo", teh: "the", tounament: "tournament", wich: "which",
};

/** Prefer known misspellings, then guesses that only add/swap a letter (the most common typos). */
function rankSuggestions(lower: string, sugs: string[]): string[] {
  const known = COMMON[lower];
  if (known && known !== lower) return [known, ...sugs.filter((s) => s.toLowerCase() !== known.toLowerCase())];
  const score = (s: string) => {
    const t = s.toLowerCase();
    let v = editDistance(lower, t) * 10;
    if (t.length > lower.length) v -= 3; // missing letter is likelier than a wrong one
    if (t[0] !== lower[0]) v += 5;
    if (t.includes("'") && !lower.includes("'")) v += 8; // don't turn a plural into a possessive
    if ([...t].sort().join("") === [...lower].sort().join("")) v -= 4; // swapped letters
    return v;
  };
  return [...sugs].sort((a, b) => score(a) - score(b));
}

function matchCase(src: string, word: string) {
  if (src === src.toUpperCase()) return word.toUpperCase();
  if (src[0] === src[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

const CONFUSABLES: [RegExp, string, string][] = [
  [/\b(could|should|would|must|might) of\b/gi, "$1 have", "Use “have”, not “of”."],
  [/\balot\b/gi, "a lot", "“A lot” is two words."],
  [/\byour welcome\b/gi, "you're welcome", "Should be “you're” (you are)."],
  [/\byour (invited|welcome to|going to|getting|the best|always)\b/gi, "you're $1", "Should be “you're” (you are)."],
  [/\bit's (own|color|colour|name|way|purpose)\b/gi, "its $1", "Possessive “its” has no apostrophe."],
  [/\b(?:their|they're) (is|are|was|were|will be)\b/gi, "there $1", "Use “there” here (there is / there are)."],
  [/\birregardless\b/gi, "regardless", "“Irregardless” is non-standard."],
  [/\b(?:they're|there) (own|new|best|first|team|staff|store|shop|kids|family)\b/gi, "their $1", "Possessive is “their”."],
  [/\b(more|less|better|worse|bigger|smaller|faster|cheaper|rather|other) then\b/gi, "$1 than", "Comparisons use “than”."],
  [/\bloose (weight|money|time)\b/gi, "lose $1", "“Lose” (not “loose”) means to misplace or shed."],
  [/\bcomplementary (coffee|drinks?|parking|wifi|wi-fi|breakfast|gift|consultation|estimate)\b/gi, "complimentary $1", "Free = “complimentary” (with an i)."],
  [/\bper say\b/gi, "per se", "Spelled “per se”."],
  [/\bfor all intensive purposes\b/gi, "for all intents and purposes", "The phrase is “intents and purposes”."],
];

const AN_EXCEPT = /^(?:hour|honest|honor|honour|heir|herb)/i; // “an hour”
const A_EXCEPT = /^(?:uni|use|usu|uti|eu|one|once|ur[aei]|u\b)/i; // “a university”, “a one-time”

function checkWordRules(text: string, add: Add, lineOf: (s: string) => string) {
  for (const [re, rep, why] of CONFUSABLES) {
    if (!why) continue;
    for (const m of text.matchAll(re)) {
      const fixed = m[0].replace(new RegExp(re.source, "i"), rep);
      add("error", "grammar", m[0], matchCase(m[0], fixed), why, lineOf(m[0]));
    }
  }
  // Doubled words: “the the”
  for (const m of text.matchAll(/\b([A-Za-z]+)\s+\1\b/gi)) {
    if (/^(?:that|had|is|bye|no|so|very|go|ha)$/i.test(m[1])) continue;
    add("error", "grammar", m[0], m[1], "Repeated word.", lineOf(m[0]));
  }
  // a / an
  for (const m of text.matchAll(/\b(a|an|A|An|AN)\s+([A-Za-z][\w-]*)/g)) {
    const [whole, art, next] = m;
    const vowelSound = /^[aeiou]/i.test(next) ? !A_EXCEPT.test(next) : AN_EXCEPT.test(next);
    if (/^[A-Z]{2,}$/.test(next)) continue; // acronyms: “an FAQ”, “a URL”, too ambiguous
    if (art.toLowerCase() === "a" && vowelSound) add("error", "grammar", whole, `${art}n ${next}`.replace(/^An/, "An").replace(/^an/, art === "A" ? "An" : "an"), "Use “an” before a vowel sound.", lineOf(whole));
    if (art.toLowerCase() === "an" && !vowelSound) add("error", "grammar", whole, `${art[0]} ${next}`, "Use “a” before a consonant sound.", lineOf(whole));
  }
  // Grocer's apostrophe on simple plurals before a price or at the end of a line: “Taco's $3”
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,})'s(?=\s*(?:[$€£]\d|\n|$|[-–—:]\s*[$€£]?\d))/gm)) {
    add("warning", "punctuation", m[0], `${m[1]}s`, "Plurals don't take an apostrophe (only possessives do).", lineOf(m[0]));
  }
}

function checkDates(text: string, add: Add, lineOf: (s: string) => string) {
  const now = new Date();
  const guessYear = (mo: number, d: number) => {
    // No year printed: assume the next occurrence of that date.
    const y = now.getFullYear();
    const candidate = new Date(y, mo, d);
    return candidate.getTime() < now.getTime() - 60 * 864e5 ? y + 1 : y;
  };
  const dayRe = "(Sun(?:day)?|Mon(?:day)?|Tue(?:s|sday)?|Wed(?:nesday)?|Thu(?:r|rs|rsday)?|Fri(?:day)?|Sat(?:urday)?)\\.?";
  const monRe = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
  const patterns: { re: RegExp; get: (m: RegExpMatchArray) => [number, number, number, number] }[] = [
    // Saturday, December 5, 2026 / Sat Dec 5th
    { re: new RegExp(`\\b${dayRe},?\\s+${monRe}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, "gi"),
      get: (m) => [dayIdx(m[1]), monthIdx(m[2]), +m[3], m[4] ? +m[4] : NaN] },
    // Saturday, 5 December 2026
    { re: new RegExp(`\\b${dayRe},?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monRe}(?:,?\\s+(\\d{4}))?`, "gi"),
      get: (m) => [dayIdx(m[1]), monthIdx(m[3]), +m[2], m[4] ? +m[4] : NaN] },
    // Saturday 12/5 or 12/5/2026
    { re: new RegExp(`\\b${dayRe},?\\s+(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?\\b`, "gi"),
      get: (m) => [dayIdx(m[1]), +m[2] - 1, +m[3], m[4] ? (m[4].length === 2 ? 2000 + +m[4] : +m[4]) : NaN] },
  ];
  for (const { re, get } of patterns) {
    for (const m of text.matchAll(re)) {
      const [dow, mo, d, yRaw] = get(m);
      if (dow < 0 || mo < 0 || mo > 11 || d < 1) continue;
      const y = Number.isNaN(yRaw) ? guessYear(mo, d) : yRaw;
      const date = new Date(y, mo, d);
      if (date.getMonth() !== mo) {
        add("error", "facts", m[0], "?", `${MONTHS[mo][0].toUpperCase() + MONTHS[mo].slice(1)} doesn't have ${d} days.`, lineOf(m[0]));
        continue;
      }
      const actual = date.getDay();
      if (actual !== dow) {
        const actualName = DAYS[actual][0].toUpperCase() + DAYS[actual].slice(1);
        add("error", "facts", m[0], m[0].replace(m[1], m[1].length <= 4 ? actualName.slice(0, 3) : actualName),
          `${date.toDateString().slice(4)} is a ${actualName}${Number.isNaN(yRaw) ? ` (assuming ${y})` : ""}, not a ${DAYS[dow][0].toUpperCase() + DAYS[dow].slice(1)}.`, lineOf(m[0]));
      }
    }
  }
  // Impossible times like 13:75 or 15pm
  for (const m of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)\b/gi)) {
    if (+m[1] > 12 || +m[1] === 0 || (m[2] && +m[2] > 59)) add("error", "facts", m[0], "?", "That isn't a valid time.", lineOf(m[0]));
  }
}

function checkContacts(text: string, add: Add, lineOf: (s: string) => string) {
  // Phone-looking groups (with separators) that have the wrong number of digits.
  for (const m of text.matchAll(/(?:\+?1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{2,6}\b/g)) {
    const digits = m[0].replace(/\D/g, "");
    const n = digits.startsWith("1") && digits.length === 11 ? 10 : digits.length;
    if (n !== 10) add("error", "facts", m[0].trim(), "?", `This phone number has ${n} digits; US numbers have 10.`, lineOf(m[0]));
  }
  // Emails
  for (const m of text.matchAll(/[\w.+-]+@[\w.-]*/g)) {
    const e = m[0].replace(/[.,;:]+$/, "");
    if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}$/i.test(e) || /\.\./.test(e)) {
      add("error", "facts", e, "?", "This email address looks incomplete or malformed.", lineOf(e));
    }
  }
  // Web addresses
  for (const m of text.matchAll(/\b(?:htt?ps?:?\/*|www\.)\S+/gi)) {
    const u = m[0].replace(/[.,;:)]+$/, "");
    if (/^htt?ps?:?\/*/i.test(u) && !/^https?:\/\//i.test(u)) add("error", "facts", u, u.replace(/^htt?ps?:?\/*/i, "https://"), "The start of this web address is mistyped.", lineOf(u));
    else if (/^www\./i.test(u) && !/^www\.[\w-]+(\.[\w-]+)*\.[a-z]{2,}/i.test(u)) add("error", "facts", u, "?", "This web address is missing its ending (.com, .net…).", lineOf(u));
    else if (/\s|,(?!\S)/.test(u) || /\.\./.test(u)) add("error", "facts", u, "?", "This web address looks malformed.", lineOf(u));
  }
}

function checkPunctuation(text: string, add: Add, lineOf: (s: string) => string) {
  for (const m of text.matchAll(/[A-Za-z]\s+([,.!?;:])(?=\s|$)/g)) {
    add("error", "punctuation", m[0], m[0].replace(/\s+/, ""), "No space before punctuation.", lineOf(m[0]));
  }
  for (const m of text.matchAll(/[a-z],(?=[A-Za-z])/g)) {
    add("error", "punctuation", m[0] + text[m.index! + 2], m[0] + " " + text[m.index! + 2], "Add a space after the comma.", lineOf(m[0]));
  }
  for (const m of text.matchAll(/([!?.,])\1+/g)) {
    if (m[0] === "...") continue;
    add("suggestion", "punctuation", m[0], m[1], "Repeated punctuation can look unprofessional in print.", lineOf(m[0]));
  }
  const pairs: [string, string, string][] = [["(", ")", "parenthesis"], ["[", "]", "bracket"], ["“", "”", "quotation mark"]];
  for (const [o, c, name] of pairs) {
    const no = text.split(o).length - 1;
    const nc = text.split(c).length - 1;
    if (no !== nc) add("warning", "punctuation", no > nc ? o : c, "", `Unmatched ${name}: ${no} opening vs ${nc} closing.`);
  }
  if ((text.match(/"/g)?.length ?? 0) % 2 === 1) add("warning", "punctuation", '"', "", "Odd number of quotation marks: one may be missing.");
  // Sentence starting with lower case after a full stop
  for (const m of text.matchAll(/[.!?]\s+([a-z][a-z]+)/g)) {
    if (/^(?:com|net|org|m|e|g|i)$/.test(m[1])) continue;
    add("suggestion", "capitalization", m[0].trim(), m[0].trim().replace(m[1], m[1][0].toUpperCase() + m[1].slice(1)), "Sentences usually start with a capital letter.", lineOf(m[0]));
  }
}

function checkConsistency(text: string, add: Add) {
  // Same phone printed two different ways
  const phones = [...text.matchAll(/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)].map((m) => m[0]);
  const digitsSet = new Set(phones.map((p) => p.replace(/\D/g, "")));
  if (digitsSet.size > 1) {
    const list = [...digitsSet];
    // Only flag near-duplicates (1–2 digits differ): likely a typo, not two different numbers.
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const diff = [...list[i]].filter((c, k) => c !== list[j][k]).length;
      if (diff <= 2) add("warning", "consistency", phones.find((p) => p.replace(/\D/g, "") === list[j])!, phones.find((p) => p.replace(/\D/g, "") === list[i])!, "Two phone numbers here are almost identical. Is one a typo?");
    }
  }
  // Mixed time formats: “5pm” and “5:00 PM”
  const styles = new Set([...text.matchAll(/\b\d{1,2}(:\d{2})?\s?(am|pm|AM|PM|a\.m\.|p\.m\.)/g)].map((m) => `${m[1] ? "colon" : "plain"}-${/^[ap]m$/.test(m[2]) ? "lower" : /\./.test(m[2]) ? "dots" : "upper"}`));
  if (styles.size > 1) add("suggestion", "consistency", "", "", "Times are written in more than one style (e.g. “5pm” and “5:00 PM”). Pick one for a cleaner look.");
  // Same capitalized word spelled two ways (e.g. “Bella's” vs “Bellas”, “Grey” vs “Gray”)
  const caps = [...new Set(text.match(/\b[A-Z][a-z]{3,}(?:'s)?\b/g) ?? [])];
  for (let i = 0; i < caps.length; i++) for (let j = i + 1; j < caps.length; j++) {
    const a = caps[i], b = caps[j];
    if (Math.abs(a.length - b.length) <= 1 && a.slice(0, 3) === b.slice(0, 3) && editDistance(a, b) === 1 && !(a + "s" === b || b + "s" === a)) {
      add("warning", "consistency", b, a, `“${a}” and “${b}” both appear. Should they match?`);
    }
  }
}

function editDistance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Optional: LanguageTool's free public API (no account; text is sent to languagetool.org). */
async function languageTool(text: string): Promise<Issue[]> {
  const res = await fetch("https://api.languagetool.org/v2/check", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ text, language: "en-US" }),
  });
  if (!res.ok) throw new Error(`LanguageTool ${res.status}`);
  const data = (await res.json()) as {
    matches: { message: string; offset: number; length: number; replacements: { value: string }[]; rule: { issueType: string; category: { id: string } } }[];
  };
  return data.matches.map((m) => {
    const type = m.rule.issueType;
    const cat = m.rule.category.id.toLowerCase();
    const category =
      type === "misspelling" ? "spelling"
      : cat.includes("punct") || cat === "typography" ? "punctuation"
      : cat.includes("casing") ? "capitalization"
      : type === "style" || cat.includes("style") || cat.includes("redundancy") ? "clarity"
      : "grammar";
    return {
      severity: (type === "misspelling" || type === "grammar" ? "error" : type === "style" || type === "locale-violation" ? "suggestion" : "warning") as Severity,
      category,
      original: text.slice(m.offset, m.offset + m.length),
      suggestion: m.replacements.slice(0, 2).map((r) => r.value).join(" or "),
      explanation: m.message,
      location: "",
    };
  });
}
