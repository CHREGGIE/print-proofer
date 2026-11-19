// Pulls useful things out of OCR'd text and files screenshots into categories.
// Pure functions, no network: works fully offline.

export type Category = "receipt" | "tracking" | "code" | "other";

export interface Entities {
  prices: string[];
  offers: string[];
  promoCodes: string[];
  links: string[];
  emails: string[];
  phones: string[];
  handles: string[];
  tracking: { carrier: string; number: string }[];
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

const PRICE_RE = /(?:[$€£]\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?\s?(?:USD|EUR|GBP|dollars))(?:\s?\/\s?(?:month|mo|year|yr|week|wk|hour|hr|each|ea))?/gi;
const PERCENT_OFF_RE = /\b\d{1,2}\s?%\s?(?:off|discount|savings?)\b/gi;
const OFFER_WORDS_RE =
  /\b(?:\d{1,2}\s?%\s?off|bogo|buy\s+(?:one|1|two|2)\s+get\s+(?:one|1)(?:\s+free|\s+\d+%\s+off)?|free\s+(?:shipping|delivery|trial|gift|consultation|estimate|\w+)|sale|clearance|limited[\s-]time|special offer|deal|save\s+(?:up\s+to\s+)?[$€£]?\d+%?|discount|coupon|ends?\s+(?:today|tonight|soon|\w+day|\d{1,2}\/\d{1,2})|while supplies last|introductory|starting at|as low as|from\s+[$€£]\d+)\b/i;
const PROMO_RE = /\b(?:code|promo(?:\s?code)?|coupon|use)\s*[:\-]?\s*([A-Z0-9]{4,15})\b/g;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ai|app|dev|shop|store|us|uk|ca|me|ly|gg|tv|biz|info)(?:\/[^\s)]*)?/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const HANDLE_RE = /(?:^|\s)(@[A-Za-z0-9_.]{2,30})\b/g;

const TRACKING_RULES: { carrier: string; re: RegExp }[] = [
  { carrier: "UPS", re: /\b1Z[0-9A-Z]{16}\b/g },
  { carrier: "USPS", re: /\b(?:94|93|92|95|94|91|70|23|03)\d{18,20}\b/g },
  { carrier: "USPS", re: /\b[A-Z]{2}\d{9}US\b/g },
  { carrier: "FedEx", re: /\b(?:\d{12}|\d{15}|\d{20}|\d{22})\b/g },
  { carrier: "Amazon", re: /\bTBA\d{12}\b/g },
  { carrier: "DHL", re: /\b\d{10}\b(?=[^\n]*\bDHL\b)|\bJJD\d{18}\b/g },
];

export function extractEntities(text: string): Entities {
  const t = text.replace(/ /g, " ");
  const lines = t.split(/\n+/);
  const promoCodes: string[] = [];
  for (const m of t.matchAll(PROMO_RE)) if (/[A-Z]/.test(m[1]) && !/^(?:THE|AND|FOR|YOUR|THIS)$/.test(m[1])) promoCodes.push(m[1]);

  const emails = uniq(t.match(EMAIL_RE) ?? []);
  const links = uniq((t.match(URL_RE) ?? []).filter((u) => !emails.some((e) => e.includes(u))));

  const tracking: Entities["tracking"] = [];
  const mentionsShipping = /track|shipp|deliver|package|carrier|ups|usps|fedex|dhl|order/i.test(t);
  for (const rule of TRACKING_RULES) {
    for (const m of t.matchAll(rule.re)) {
      // Bare digit runs are only tracking numbers when the screenshot is about shipping.
      if (/^\d+$/.test(m[0]) && !mentionsShipping) continue;
      if (!tracking.some((x) => x.number === m[0])) tracking.push({ carrier: rule.carrier, number: m[0] });
    }
  }

  return {
    prices: uniq(t.match(PRICE_RE) ?? []),
    offers: uniq([...(t.match(PERCENT_OFF_RE) ?? []), ...lines.filter((l) => OFFER_WORDS_RE.test(l))]).slice(0, 30),
    promoCodes: uniq(promoCodes),
    links,
    emails,
    phones: uniq(t.match(PHONE_RE) ?? []),
    handles: uniq([...t.matchAll(HANDLE_RE)].map((m) => m[1])),
    tracking,
  };
}

export interface Classification {
  category: Category;
  label: string; // short human summary, e.g. "Receipt · $42.17" or "UPS 1Z…"
}

export function classify(text: string): Classification {
  const t = text;
  const e = extractEntities(t);

  // Tracking numbers win: they are the most actionable.
  if (e.tracking.length && /track|shipp|deliver|package|out for delivery|in transit|carrier|label/i.test(t)) {
    const first = e.tracking[0];
    return { category: "tracking", label: `${first.carrier} ${first.number}` };
  }

  // Receipts / orders / invoices
  let receiptScore = 0;
  if (/\b(?:sub-?total|total|tax|tip|amount (?:due|paid)|balance)\b/i.test(t)) receiptScore += 2;
  if (/\b(?:receipt|invoice|order\s*(?:#|number|no\.?|confirmation)|payment|paid|transaction|visa|mastercard|amex|debit|card ending|\*{3,}\s?\d{4})\b/i.test(t)) receiptScore += 2;
  if (e.prices.length >= 2) receiptScore += 1;
  if (receiptScore >= 3) {
    const total =
      t.match(/\b(?:grand\s+)?total(?:\s+(?:paid|due|charged))?\s*[:\-]?\s*([$€£]?\s?\d[\d,]*\.\d{2})/i)?.[1] ??
      e.prices[e.prices.length - 1];
    return { category: "receipt", label: total ? `Receipt · ${total.replace(/\s/g, "")}` : "Receipt" };
  }

  // Code snippets
  const codeSignals = [
    /[{};]\s*$/m,
    /\b(?:function|const|let|var|return|import|export|def|class|public|private|static|void|async|await|elif|lambda|#include|SELECT|FROM|WHERE)\b/,
    /=>|===|!==|::|->|\+\+|&&|\|\|/,
    /^\s{2,}\S/m,
    /\w+\([^)]*\)\s*[{:;]/,
    /<\/?[a-z]+[^>]*>/i,
    /^\s*(?:\$|>|npm|pip|git|sudo|cd|ls)\s/m,
  ];
  const codeScore = codeSignals.filter((re) => re.test(t)).length;
  if (codeScore >= 3) {
    const lang =
      /\bdef\b|\bimport\s+\w+$|elif|self\./m.test(t) ? "Python"
      : /\bconst\b|\blet\b|=>|function\b/.test(t) ? "JavaScript"
      : /\bSELECT\b|\bFROM\b/.test(t) ? "SQL"
      : /<\/?[a-z]+[^>]*>/i.test(t) ? "HTML"
      : /^\s*(?:\$|npm|pip|git|sudo)\s/m.test(t) ? "Shell"
      : "Code";
    return { category: "code", label: `${lang} snippet` };
  }

  const firstLine = t.split("\n").map((l) => l.trim()).find((l) => l.length > 3) ?? "";
  return { category: "other", label: firstLine.slice(0, 50) };
}

/** Normalised line for de-duplicating text seen in several video frames / captures. */
export function normLine(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9$%€£.]+/g, " ").trim();
}

/** What changed between two captures of the same competitor. */
export function diffCaptures(prev: Entities, next: Entities) {
  const d = (a: string[], b: string[]) => {
    const A = new Set(a.map(normLine));
    const B = new Set(b.map(normLine));
    return { added: b.filter((x) => !A.has(normLine(x))), removed: a.filter((x) => !B.has(normLine(x))) };
  };
  return {
    prices: d(prev.prices, next.prices),
    offers: d(prev.offers, next.offers),
    promoCodes: d(prev.promoCodes, next.promoCodes),
  };
}
