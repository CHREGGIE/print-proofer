// QR code and barcode checker. Finds every code on a proof, decodes it, and checks it against
// the printed text: does the link load, does it match the address printed beside it, does the
// phone in the QR match the printed phone, does the number under a barcode match the bars.
import { isNative, NativeOcr } from "./native";
import { extractEntities } from "./extract";
import type { Issue } from "./proof";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface FoundCode {
  format: string; // "QR", "EAN-13", "UPC-A", "Code 128" ...
  raw: string;
  box?: Box; // in image pixels
}

export type CheckState = "ok" | "warn" | "bad" | "info";
export interface CodeCheck {
  state: CheckState;
  text: string;
}
export interface CodeReport {
  format: string;
  raw: string;
  kind: "link" | "phone" | "email" | "contact" | "wifi" | "text" | "product";
  link?: string;
  checks: CodeCheck[];
}

// ---------------------------------------------------------------- finding codes

export async function scanCodes(base64: string): Promise<FoundCode[]> {
  if (isNative) {
    try {
      const { codes } = await NativeOcr.scanCodes({ base64 });
      return dedupe(codes);
    } catch {
      return [];
    }
  }
  // Browser: ZXing compiled to WebAssembly (self-hosted, so it works offline). Reads every QR
  // and product barcode on the page in one pass.
  const { prepareZXingModule, readBarcodes } = await import("zxing-wasm/reader");
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? new URL("./vendor/zxing/zxing_reader.wasm", location.href).href : prefix + path),
    },
  });
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const results = await readBarcodes(new Blob([bytes], { type: "image/jpeg" }), { tryHarder: true, maxNumberOfSymbols: 12 });
  return dedupe(
    results
      .filter((r) => r.isValid && r.text)
      .map((r) => {
        const p = r.position;
        const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x];
        const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y];
        const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        return { format: formatName(String(r.format)), raw: r.text, box };
      }),
  );
}

const formatName = (f: string) =>
  ({ QRCode: "QR", MicroQRCode: "QR", rMQRCode: "QR", "EAN-13": "EAN-13", EAN13: "EAN-13", "EAN-8": "EAN-8", EAN8: "EAN-8", "UPC-A": "UPC-A", UPCA: "UPC-A", "UPC-E": "UPC-E", UPCE: "UPC-E", ITF14: "ITF-14", DataBar: "GS1 DataBar", Code128: "Code 128", Code39: "Code 39", DataMatrix: "Data Matrix", PDF417: "PDF417", ITF: "ITF" })[f] ?? f;

/**
 * Paint over the codes before reading the text: OCR otherwise reads QR squares and barcode
 * stripes as junk "words" and reports them as spelling mistakes.
 */
export async function maskCodes(base64: string, codes: FoundCode[]): Promise<string> {
  const boxes = codes.map((c) => c.box).filter((b): b is Box => !!b);
  if (!boxes.length) return base64;
  const img = new Image();
  img.src = `data:image/jpeg;base64,${base64}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  ctx.fillStyle = "#fff";
  for (const b of boxes) {
    const pad = Math.max(b.w, b.h) * 0.12; // the quiet zone around the code
    ctx.fillRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
  }
  return c.toDataURL("image/jpeg", 0.92).split(",")[1];
}

const dedupe = (codes: FoundCode[]) => codes.filter((c, i) => codes.findIndex((d) => d.raw === c.raw) === i);

// ---------------------------------------------------------------- checking codes

const SHORTENERS = /^(bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|t\.co|rebrand\.ly|is\.gd|buff\.ly|cutt\.ly|shorturl\.at|tiny\.cc|qrco\.de|qr\.page|linktr\.ee)$/i;
const host = (u: string) => {
  try {
    return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
};
const digits = (s: string) => s.replace(/\D/g, "");

function editDistance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** GS1 check digit for EAN-8, UPC-A (12) and EAN-13. */
export function gs1Valid(code: string): boolean {
  const d = digits(code);
  if (![8, 12, 13].includes(d.length)) return false;
  const body = d.slice(0, -1).split("").map(Number);
  const sum = body.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(d.at(-1));
}

/** Does the address answer? Opaque (no-cors) responses still prove the site is up. */
async function linkLoads(url: string): Promise<boolean | null> {
  if (!navigator.onLine) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    await fetch(url, { mode: "no-cors", signal: ctrl.signal, cache: "no-store", redirect: "follow" });
    return true;
  } catch {
    return ctrl.signal.aborted ? null : false;
  } finally {
    clearTimeout(t);
  }
}

export async function checkCodes(codes: FoundCode[], printed: string): Promise<CodeReport[]> {
  const e = extractEntities(printed);
  const printedHosts = [...new Set([...e.links.map(host), ...e.emails.map((m) => m.split("@")[1]?.toLowerCase() ?? "")].filter(Boolean))];
  const printedPhones = e.phones.map(digits).map((p) => (p.length === 11 && p.startsWith("1") ? p.slice(1) : p));

  return Promise.all(
    codes.map(async (c): Promise<CodeReport> => {
      const raw = c.raw.trim();
      const checks: CodeCheck[] = [{ state: "ok", text: "Scans cleanly from your photo." }];

      // Product barcodes
      if (/^(EAN|UPC)/.test(c.format) || (c.format !== "QR" && /^\d{8,13}$/.test(raw))) {
        checks.push(gs1Valid(raw) ? { state: "ok", text: "Check digit is valid." } : { state: "bad", text: "Check digit is wrong: shops' scanners will reject it." });
        const runs = (printed.match(/\d[\d ]{6,18}\d/g) ?? []).map(digits).filter((d) => Math.abs(d.length - raw.length) <= 1);
        if (runs.length && !runs.some((d) => d === raw || d === raw.slice(1) || `0${d}` === raw)) {
          checks.push({ state: "bad", text: `The number printed under the bars (${runs[0]}) doesn't match the code (${raw}).` });
        } else if (runs.length) checks.push({ state: "ok", text: "Printed number matches the bars." });
        return { format: c.format, raw, kind: "product", checks };
      }

      // Phone, email, contact card, Wi-Fi
      if (/^tel:/i.test(raw) || /^sms(to)?:/i.test(raw)) {
        const p = digits(raw).replace(/^1(?=\d{10}$)/, "");
        checks.push(phoneCheck(p, printedPhones));
        return { format: c.format, raw, kind: "phone", checks };
      }
      if (/^mailto:/i.test(raw) || /^MATMSG:/i.test(raw)) {
        const addr = raw.replace(/^mailto:|^MATMSG:TO:/i, "").split(/[?;]/)[0];
        const dom = addr.split("@")[1]?.toLowerCase() ?? "";
        checks.push(!dom ? { state: "bad", text: "The email address in the code is incomplete." } : printedHosts.length && !printedHosts.includes(dom) ? { state: "warn", text: `The code emails ${addr}, but the printed address uses ${printedHosts.join(", ")}.` } : { state: "ok", text: `Emails ${addr}.` });
        return { format: c.format, raw, kind: "email", checks };
      }
      if (/^BEGIN:VCARD/i.test(raw) || /^MECARD:/i.test(raw)) {
        const tel = raw.match(/TEL[^:]*:([^\n;]+)/i)?.[1];
        if (tel) checks.push(phoneCheck(digits(tel).replace(/^1(?=\d{10}$)/, ""), printedPhones));
        const url = raw.match(/URL[^:]*:([^\n;]+)/i)?.[1];
        if (url) checks.push(...hostChecks(host(url), printedHosts));
        return { format: c.format, raw, kind: "contact", checks };
      }
      if (/^WIFI:/i.test(raw)) {
        const ssid = raw.match(/S:([^;]*)/)?.[1] ?? "";
        checks.push({ state: "info", text: `Joins the Wi-Fi network “${ssid}”. Test it on site.` });
        if (ssid && !printed.includes(ssid)) checks.push({ state: "info", text: "The network name isn't printed next to the code." });
        return { format: c.format, raw, kind: "wifi", checks };
      }

      // Links
      const looksLink = /^https?:\/\//i.test(raw) || /^www\./i.test(raw) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(raw);
      if (looksLink) {
        const url = /^https?:/i.test(raw) ? raw : `https://${raw}`;
        const h = host(url);
        if (/^http:/i.test(raw)) checks.push({ state: "warn", text: "Uses http, not https: some phones warn that the page isn't secure." });
        if (SHORTENERS.test(h)) checks.push({ state: "warn", text: `Short link (${h}): confirm where it goes, and that the account won't lapse before the print run ends.` });
        checks.push(...hostChecks(h, printedHosts));
        const ok = await linkLoads(url);
        checks.push(ok === true ? { state: "ok", text: "The link loads." } : ok === false ? { state: "bad", text: "The link doesn't load: the site is down or the address is wrong." } : { state: "info", text: "Couldn't test the link (offline). Open it before printing." });
        return { format: c.format, raw, kind: "link", link: url, checks };
      }

      checks.push({ state: "info", text: "Plain text, not a link." });
      return { format: c.format, raw, kind: "text", checks };
    }),
  );
}

function phoneCheck(p: string, printed: string[]): CodeCheck {
  if (p.length !== 10) return { state: "bad", text: `The phone number in the code has ${p.length} digits.` };
  if (printed.length && !printed.includes(p)) return { state: "bad", text: `The code dials ${fmtPhone(p)}, but the printed number is ${fmtPhone(printed[0])}.` };
  return { state: "ok", text: `Dials ${fmtPhone(p)}${printed.length ? ", same as printed" : ""}.` };
}
const fmtPhone = (p: string) => (p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p);

function hostChecks(h: string, printedHosts: string[]): CodeCheck[] {
  if (!h || !printedHosts.length) return [];
  if (printedHosts.includes(h)) return [{ state: "ok", text: `Goes to ${h}, same as the printed address.` }];
  const near = printedHosts.find((p) => editDistance(p, h) <= 2);
  if (near) return [{ state: "bad", text: `Typo: the code goes to ${h} but the printed address is ${near}.` }];
  if (SHORTENERS.test(h)) return [];
  return [{ state: "warn", text: `The code goes to ${h}, but the printed address is ${printedHosts.join(", ")}.` }];
}

/** Turn code problems into proofreading issues, so they count in the verdict. */
export function codeIssues(reports: CodeReport[]): Issue[] {
  return reports.flatMap((r) =>
    r.checks
      .filter((c) => c.state === "bad" || c.state === "warn")
      .map((c) => ({
        severity: c.state === "bad" ? ("error" as const) : ("warning" as const),
        category: "codes",
        original: "",
        suggestion: "",
        explanation: `${r.format} code: ${c.text}`,
        location: r.format,
      })),
  );
}
