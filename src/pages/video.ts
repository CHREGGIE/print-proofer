// Video OCR: step through a video, read the on-screen text from frames, and pull
// out tool names, prompts, prices, offers and links (what transcripts miss).
import { extractEntities, normLine } from "../extract";
import { likelyNames } from "../offline";
import { ocrCanvas } from "../ocr";
import { summarizeVideoText, ProofError } from "../proof";
import { $, el, show, hide, drawScaled, settings, copyText } from "../util";

interface Line {
  t: number;
  text: string;
}

const video = $<HTMLVideoElement>("videoEl");
const progressBox = $("videoProgress");
const bar = $("videoBar");
const setBar = (f: number) => (bar.style.width = `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`);
const status = $("videoStatus");
const results = $("videoResults");
let cancelled = false;
let lines: Line[] = [];

export function initVideo() {
  const input = $<HTMLInputElement>("videoInput");
  input.onchange = () => {
    const f = input.files?.[0];
    input.value = "";
    if (f) run(f);
  };
  $("videoCancel").onclick = () => (cancelled = true);
  $("videoCopy").onclick = (e) => copyText(e.currentTarget as HTMLButtonElement, lines.map((l) => `[${ts(l.t)}] ${l.text}`).join("\n"));
  $("videoClaudeBtn").onclick = askClaude;
}

const ts = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function once(target: EventTarget, ev: string) {
  return new Promise<void>((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error("This video can't be read on this device.")); };
    const cleanup = () => { target.removeEventListener(ev, ok); target.removeEventListener("error", bad); };
    target.addEventListener(ev, ok);
    target.addEventListener("error", bad);
  });
}

/** 48px grayscale fingerprint, to skip frames that haven't changed. */
function fingerprint(c: HTMLCanvasElement): Uint8Array {
  const small = drawScaled(c, c.width, c.height, 48);
  const d = small.getContext("2d")!.getImageData(0, 0, small.width, small.height).data;
  const out = new Uint8Array(d.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return out;
}
// Share of pixels that changed noticeably; text changes on a plain background are small, so keep this low.
const changed = (a: Uint8Array | null, b: Uint8Array) => !a || a.filter((v, i) => Math.abs(v - b[i]) > 24).length / a.length > 0.004;

async function run(file: File) {
  cancelled = false;
  lines = [];
  hide(results);
  $("videoClaudeOut").replaceChildren();
  video.src = URL.createObjectURL(file);
  show(video);
  show(progressBox);
  setBar(0);
  $("videoCancel").hidden = false;
  status.textContent = "Opening video…";
  try {
    if (video.readyState < 1) await once(video, "loadedmetadata");
    const step = Number($<HTMLSelectElement>("videoInterval").value) || 2;
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("Couldn't read the video's length.");
    const seen = new Set<string>();
    let last: Uint8Array | null = null;
    let read = 0;
    for (let t = 0; t < dur && !cancelled; t += step) {
      video.currentTime = Math.min(t, dur - 0.05);
      await once(video, "seeked");
      const frame = drawScaled(video, video.videoWidth, video.videoHeight, 1600);
      setBar(t / dur);
      const fp = fingerprint(frame);
      if (!changed(last, fp)) continue;
      last = fp;
      read++;
      status.textContent = `Reading ${ts(t)} of ${ts(dur)} · ${lines.length} lines found`;
      const text = await ocrCanvas(frame);
      for (const raw of text.split("\n")) {
        const l = raw.trim();
        const key = normLine(l);
        if (key.length < 3 || seen.has(key)) continue;
        seen.add(key);
        lines.push({ t, text: l });
      }
    }
    setBar(1);
    await renderResults();
    status.textContent = `${cancelled ? "Stopped" : "Done"}: read ${read} distinct frames, found ${lines.length} lines of text.`;
  } catch (e) {
    status.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    $("videoCancel").hidden = true;
  }
}

const PROMPT_START = /^(?:["“']|(?:write|create|generate|make|design|draw|imagine|act as|you are|give me|explain|summari[sz]e|list|rewrite|translate|build|plan|draft|describe|turn|convert|help me)\b)/i;

async function renderResults() {
  const all = lines.map((l) => l.text).join("\n");
  const e = extractEntities(all);
  const names = (await likelyNames(all)).filter((n) => !e.promoCodes.includes(n));
  // Join quoted prompts that wrapped onto several lines of the same frame.
  const merged: Line[] = [];
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    const open = prev && prev.t === l.t && /^["“]/.test(prev.text) && !/["”]$/.test(prev.text);
    if (open) prev.text = `${prev.text} ${l.text}`;
    else merged.push({ ...l });
  }
  const prompts = merged.filter((l) => l.text.split(/\s+/).length >= 6 && PROMPT_START.test(l.text)).map((l) => l.text);

  const firstTime = (needle: string) => {
    const hit = lines.find((l) => l.text.includes(needle) || needle.includes(l.text));
    return hit ? hit.t : null;
  };
  const group = (title: string, items: string[], kind = "") => {
    if (!items.length) return null;
    return el(
      "section",
      { class: "panel" },
      el("header", { class: "panel-head" }, el("h2", { textContent: title }), el("span", { class: "meta", textContent: String(Math.min(items.length, 40)) })),
      el(
        "div",
        { class: "chips" },
        ...items.slice(0, 40).map((it) => {
          const t = firstTime(it);
          const b = el("button", { class: `chip ${kind}` }, el("span", { textContent: it }));
          if (t != null) b.append(el("span", { class: "at", textContent: ts(t) }));
          b.onclick = () => t != null && seek(t);
          return b;
        }),
      ),
    );
  };
  const groups = [
    group("Tools and names", names),
    group("Prompts", prompts),
    group("Prices", e.prices, "price"),
    group("Offers and codes", [...e.offers, ...e.promoCodes.map((c) => `Code ${c}`)], "offer"),
    group("Links and handles", [...e.links, ...e.handles, ...e.emails]),
  ].filter((g): g is HTMLElement => g !== null);
  $("videoEntities").replaceChildren(...(groups.length ? groups : [el("div", { class: "empty spaced" }, "No prices, offers, links or names spotted. The full text is below.")]));

  $("videoLines").replaceChildren(
    ...lines.map((l) => {
      const li = el("li", {}, el("span", { class: "time", textContent: ts(l.t) }), el("span", { textContent: l.text }));
      li.onclick = () => seek(l.t);
      return li;
    }),
  );
  if (!lines.length) $("videoLines").append(el("li", { textContent: "No on-screen text found." }));
  show(results);
}

function seek(t: number) {
  video.currentTime = t;
  video.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function askClaude() {
  const out = $("videoClaudeOut");
  if (!settings.apiKey) {
    out.replaceChildren(el("p", { class: "hint", textContent: "Add your Anthropic API key in Settings to use this." }));
    return;
  }
  if (!lines.length) return;
  const btn = $<HTMLButtonElement>("videoClaudeBtn");
  btn.disabled = true;
  out.replaceChildren(el("p", { class: "hint", textContent: "Asking Claude…" }));
  try {
    const r = await summarizeVideoText(settings.apiKey, lines.map((l) => `[${ts(l.t)}] ${l.text}`).join("\n"));
    const sec = (title: string, xs: string[]) =>
      xs.length ? [el("h3", { textContent: title }), el("ul", {}, ...xs.map((x) => el("li", { textContent: x })))] : [];
    out.replaceChildren(
      el("p", { textContent: r.summary }),
      ...sec("Tools & products", r.tools),
      ...sec("Prompts", r.prompts),
      ...sec("Prices", r.prices),
      ...sec("Offers", r.offers),
      ...sec("Links", r.links),
    );
  } catch (e) {
    out.replaceChildren(el("p", { class: "hint", textContent: e instanceof ProofError ? e.message : String(e) }));
  } finally {
    btn.disabled = false;
  }
}
