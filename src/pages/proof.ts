import { proofread, ProofError, type Issue, type ProofResult } from "../proof";
import { proofreadOffline } from "../offline";
import { ocrBase64 } from "../ocr";
import { $, show, hide, el, settings, prepareImage, copyText, type PreparedImage } from "../util";
import { iconEl } from "../icons";
import { canSpeak, readAloud, stopReading } from "../speech";
import { scanCodes, maskCodes, checkCodes, codeIssues, type CodeReport, type FoundCode } from "../codes";

const cameraInput = $<HTMLInputElement>("cameraInput");
const fileInput = $<HTMLInputElement>("fileInput");
const thumbs = $("thumbs");
const textInput = $<HTMLTextAreaElement>("textInput");
const notesInput = $<HTMLTextAreaElement>("notesInput");
const checkBtn = $<HTMLButtonElement>("checkBtn");
const statusCard = $("statusCard");
const statusText = $("statusText");
const elapsed = $("elapsed");
const errorCard = $("errorCard");
const results = $("results");
const summaryEl = $("summary");
const issuesEl = $("issues");
const transcriptionEl = $("transcription");
const correctedEl = $("corrected");
const historySection = $("historySection");
const historyList = $("historyList");

let picked: PreparedImage[] = [];
let controller: AbortController | null = null;
let openSettings: () => void = () => {};

export function initProof(opts: { openSettings: () => void }) {
  openSettings = opts.openSettings;
  cameraInput.onchange = () => {
    if (cameraInput.files) addImages(cameraInput.files);
    cameraInput.value = "";
  };
  fileInput.onchange = () => {
    if (fileInput.files) addImages(fileInput.files);
    fileInput.value = "";
  };
  textInput.oninput = updateCheckBtn;
  document.addEventListener("paste", (e) => {
    if (!$("page-proof").hidden) {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) addImages(files);
    }
  });

  document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((b) => {
    b.onclick = () => {
      settings.engine = b.dataset.engine as "offline" | "claude";
      renderEngine();
    };
  });
  renderEngine();

  checkBtn.onclick = runCheck;
  $("cancelBtn").onclick = () => controller?.abort();
  initReadAloud();
  $("newBtn").onclick = () => {
    stopReadingUi();
    picked = [];
    textInput.value = "";
    notesInput.value = "";
    renderThumbs();
    hide(results);
    hide(errorCard);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  $("clearHistoryBtn").onclick = () => {
    settings.raw.set("pp.history", "[]");
    renderHistory();
  };
  renderHistory();
  renderJobNo();
}

function renderEngine() {
  document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((b) => {
    const on = b.dataset.engine === settings.engine;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
}

/** Start a fresh check of these pictures (from a notification or the Screenshots tab). */
export async function proofImages(files: Blob[]) {
  picked = [];
  textInput.value = "";
  hide(results);
  await addImages(files);
  window.scrollTo({ top: 0 });
  if (picked.length) await runCheck();
}

/** Start a fresh check of text already read from a picture. */
export async function proofText(text: string) {
  picked = [];
  renderThumbs();
  hide(results);
  addSharedText(text);
  await runCheck();
}

export async function addImages(files: Iterable<Blob>) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    try {
      picked.push(await prepareImage(f));
    } catch {
      showError("Couldn't open that image. Try a JPG or PNG.");
    }
  }
  renderThumbs();
}

export function addSharedText(t: string) {
  textInput.value = t;
  ($("textDetails") as HTMLDetailsElement).open = true;
  updateCheckBtn();
}

function renderThumbs() {
  const has = picked.length > 0;
  $("captureSlot").hidden = has;
  $("thumbsWrap").hidden = !has;
  $("pageCount").textContent = `${picked.length} PAGE${picked.length === 1 ? "" : "S"}`;
  const tiles: HTMLElement[] = picked.map((p, i) => {
    const rm = el("button", { class: "thumb-x", ariaLabel: `Remove page ${i + 1}` }, iconEl("x", 16));
    rm.onclick = () => {
      picked.splice(i, 1);
      renderThumbs();
    };
    return el("div", { class: "thumb" }, el("img", { src: p.dataUrl, alt: `Page ${i + 1}` }), el("span", { class: "page-no", textContent: String(i + 1) }), rm);
  });
  if (has) {
    const add = el("label", { class: "thumb add", ariaLabel: "Add a page" }, iconEl("plus", 22));
    const inp = el("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
    inp.onchange = () => {
      if (inp.files) addImages(inp.files);
    };
    add.append(inp);
    tiles.push(add);
  }
  thumbs.replaceChildren(...tiles);
  updateCheckBtn();
}

export function renderJobNo() {
  $("jobNo").textContent = `JOB ${String(Number(settings.raw.get("pp.jobs") || "0") + 1).padStart(4, "0")}`;
}

function updateCheckBtn() {
  checkBtn.disabled = picked.length === 0 && !textInput.value.trim();
}

async function runCheck() {
  const useClaude = settings.engine === "claude";
  if (useClaude && !settings.apiKey) {
    showError("The Claude deep check needs an API key. Add one in Settings, or switch to the free On-device checker.");
    openSettings();
    return;
  }
  hide(errorCard);
  hide(results);
  show(statusCard);
  checkBtn.disabled = true;
  controller = new AbortController();

  const started = Date.now();
  const steps = useClaude
    ? ["Reading your proof…", "Checking spelling…", "Checking grammar & punctuation…", "Cross-checking names, dates & numbers…", "Looking at layout…", "Almost done…"]
    : ["Reading the text on the phone…", "Checking spelling…", "Checking dates, phones & links…"];
  statusText.textContent = steps[0];
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    elapsed.textContent = `${s}s`;
    if (useClaude) statusText.textContent = steps[Math.min(steps.length - 1, Math.floor(s / 8))];
  }, 1000);

  const notes = [settings.notes, notesInput.value].filter((n) => n.trim()).join("\n");
  // QR codes and barcodes are read from each picture first (fast); the offline reader then
  // reads the text with the codes painted out.
  const codesPerPage: FoundCode[][] = await Promise.all(picked.map((p) => scanCodes(p.base64).catch(() => [] as FoundCode[])));
  try {
    let result: ProofResult;
    if (useClaude) {
      result = await proofread({
        apiKey: settings.apiKey,
        images: picked.map((p) => ({ mediaType: "image/jpeg" as const, base64: p.base64 })),
        text: textInput.value,
        notes,
        signal: controller.signal,
      });
    } else {
      const parts: string[] = [];
      for (let i = 0; i < picked.length; i++) {
        if (controller.signal.aborted) throw new ProofError("Cancelled.");
        statusText.textContent = picked.length > 1 ? `Reading page ${i + 1} of ${picked.length}…` : steps[0];
        const t = await ocrBase64(await maskCodes(picked[i].base64, codesPerPage[i]).catch(() => picked[i].base64));
        parts.push(picked.length > 1 ? `[Page ${i + 1}]\n${t}` : t);
      }
      if (textInput.value.trim()) parts.push(textInput.value.trim());
      statusText.textContent = steps[1];
      result = await proofreadOffline(parts.join("\n\n"), { notes, languageTool: settings.languageTool });
      if (controller.signal.aborted) throw new ProofError("Cancelled.");
    }
    const found = codesPerPage.flat().filter((c, i, all) => all.findIndex((d) => d.raw === c.raw) === i);
    if (found.length) {
      statusText.textContent = `Testing ${found.length === 1 ? "the code" : `${found.length} codes`}…`;
      const reports = await checkCodes(found, `${result.transcription}\n${textInput.value}`);
      result.codes = reports;
      result.issues.push(...codeIssues(reports));
    }
    renderResult(result, useClaude ? "claude" : "offline");
    settings.raw.set("pp.jobs", String(Number(settings.raw.get("pp.jobs") || "0") + 1));
    renderJobNo();
    saveHistory(result);
  } catch (err) {
    showError(err instanceof ProofError ? err.message : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearInterval(timer);
    elapsed.textContent = "";
    hide(statusCard);
    controller = null;
    updateCheckBtn();
  }
}

const SEVERITY_ORDER = { error: 0, warning: 1, suggestion: 2 } as const;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function renderResult(r: ProofResult, engine?: "offline" | "claude") {
  const issues = [...r.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { error: 0, warning: 0, suggestion: 0 };
  issues.forEach((i) => counts[i.severity]++);
  const clean = counts.error === 0 && counts.warning === 0;
  const state = clean ? "ok" : counts.error ? "bad" : "warn";

  const big = clean ? 0 : counts.error || counts.warning;
  const label = clean
    ? "Mistakes found. Ready to print."
    : counts.error
      ? `${counts.error === 1 ? "Mistake" : "Mistakes"} to fix before it prints`
      : `${counts.warning === 1 ? "Thing" : "Things"} to check before it prints`;
  const stamp = { ok: ["Approved", "OK to print"], bad: ["Not ready", "Hold the press"], warn: ["Check first", "Then print"] }[state];

  summaryEl.className = `sheet verdict ${state}`;
  const legend = el(
    "div",
    { class: "legend" },
    el("span", {}, el("i", { class: "dot m" }), plural(counts.error, "mistake")),
    el("span", {}, el("i", { class: "dot y" }), `${counts.warning} to check`),
    el("span", {}, el("i", { class: "dot c" }), plural(counts.suggestion, "idea")),
  );
  summaryEl.replaceChildren(
    el("div", { class: "big", textContent: String(big) }),
    el("div", { class: "lab", textContent: label }),
    el("div", { class: `stamp ${state}` }, stamp[0], el("small", { textContent: stamp[1] })),
    legend,
    el("p", { class: "summary", textContent: r.summary }),
  );
  if (engine === "offline" && settings.apiKey) {
    const b = el("button", { class: "btn small", textContent: "Also run Claude" });
    b.onclick = () => {
      settings.engine = "claude";
      renderEngine();
      runCheck();
    };
    summaryEl.append(b);
  }

  $("issueCount").textContent = issues.length ? `${issues.length} ITEM${issues.length === 1 ? "" : "S"}` : "";
  issuesEl.replaceChildren(...(issues.length ? issues.map(renderIssue) : [el("li", {}, el("span", { class: "empty-row", textContent: "Nothing to correct. Clean proof." }))]));
  renderCodes(r.codes ?? []);
  stopReadingUi();
  shown = { text: r.transcription, issues };
  transcriptionEl.replaceChildren(markUp(r.transcription, issues));
  correctedEl.textContent = r.corrected_text;
  $<HTMLButtonElement>("copyBtn").onclick = (e) => copyText(e.currentTarget as HTMLButtonElement, r.corrected_text);

  show(results);
  summaryEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderIssue(i: Issue): HTMLElement {
  const line = i.location.match(/line\s*(\d+)/i);
  const where = line ? `Line ${line[1].padStart(2, "0")}` : i.category.slice(0, 7);
  const li = el("li", { class: i.severity }, el("span", { class: "ln" }, el("i"), where));
  li.append(
    i.original
      ? el(
          "div",
          { class: "change" },
          el("del", { textContent: i.original }),
          el("span", { class: "arrow", textContent: "→" }),
          el("ins", { textContent: i.suggestion && i.suggestion !== "?" ? i.suggestion : "check" }),
        )
      : el("div", { class: "change", textContent: i.category[0].toUpperCase() + i.category.slice(1) }),
  );
  li.append(el("p", { class: "why", textContent: i.explanation }));
  return li;
}

// ---------------- read aloud ----------------
let shown: { text: string; issues: Issue[] } = { text: "", issues: [] };
let reading = false;
let rate = 1;

export function initReadAloud() {
  const btn = $<HTMLButtonElement>("readBtn");
  btn.hidden = !canSpeak();
  btn.onclick = () => (reading ? stopReadingUi() : startReading(0));
  document.querySelectorAll<HTMLButtonElement>("#readRate button").forEach((b) => {
    b.onclick = () => {
      rate = Number(b.dataset.rate);
      document.querySelectorAll("#readRate button").forEach((x) => x.classList.toggle("active", x === b));
    };
  });
}

/** Swap the marked-up proof for the plain text as words, so the spoken word can light up. */
function startReading(from: number) {
  reading = true;
  $("readBar").hidden = false;
  document.querySelector<HTMLElement>("#results .key")!.hidden = true;
  const btn = $<HTMLButtonElement>("readBtn");
  btn.replaceChildren(iconEl("x", 16), " ", el("span", { textContent: "Stop" }));
  const frag = document.createDocumentFragment();
  const words: HTMLElement[] = [];
  let pos = 0;
  for (const m of shown.text.matchAll(/\S+/g)) {
    frag.append(shown.text.slice(pos, m.index));
    const w = el("span", { className: "rw", textContent: m[0] });
    w.dataset.start = String(m.index);
    w.onclick = () => startReading(m.index!);
    words.push(w);
    frag.append(w);
    pos = m.index! + m[0].length;
  }
  frag.append(shown.text.slice(pos));
  transcriptionEl.replaceChildren(frag);
  let last: HTMLElement | null = null;
  readAloud({
    text: shown.text,
    from,
    rate,
    onWord: (start) => {
      const w = words.find((x) => Number(x.dataset.start) <= start && start < Number(x.dataset.start) + x.textContent!.length) ?? words.find((x) => Number(x.dataset.start) >= start);
      if (!w || w === last) return;
      last?.classList.remove("now");
      w.classList.add("now");
      last = w;
      const r = w.getBoundingClientRect();
      if (r.top < 90 || r.bottom > innerHeight - 90) w.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    onEnd: stopReadingUi,
  });
}

function stopReadingUi() {
  if (!reading) return;
  reading = false;
  stopReading();
  $("readBar").hidden = true;
  document.querySelector<HTMLElement>("#results .key")!.hidden = false;
  $<HTMLButtonElement>("readBtn").replaceChildren(iconEl("play", 16), " ", el("span", { textContent: "Read aloud" }));
  transcriptionEl.replaceChildren(markUp(shown.text, shown.issues));
}

const MARK: Record<string, string> = { ok: "✓", warn: "!", bad: "✕", info: "i" };

function renderCodes(reports: CodeReport[]) {
  const panel = $("codesPanel");
  panel.hidden = reports.length === 0;
  $("codesCount").textContent = reports.length ? `${reports.length} FOUND` : "";
  $("codesList").replaceChildren(
    ...reports.map((r) => {
      const bad = r.checks.some((c) => c.state === "bad");
      const warn = r.checks.some((c) => c.state === "warn");
      const actions = el("div", { className: "actions" });
      if (r.link) actions.append(el("a", { className: "btn small", href: r.link, target: "_blank", rel: "noopener" }, iconEl("external", 16), "Open link"));
      const copy = el("button", { className: "btn small" }, iconEl("copy", 16), "Copy");
      copy.onclick = () => copyText(copy, r.raw);
      actions.append(copy);
      return el(
        "li",
        { className: "code-row" },
        el("div", { className: "code-head" }, el("span", { className: `tag ${bad ? "m" : warn ? "y" : "c"}`, textContent: r.format }), el("span", { className: "code-raw", textContent: r.raw })),
        el("ul", { className: "checks" }, ...r.checks.map((c) => el("li", { className: c.state }, el("b", { textContent: MARK[c.state] }), c.text))),
        actions,
      );
    }),
  );
}

/** The proof with editor's marks: errors struck with the fix written in, warnings underlined. */
function markUp(text: string, issues: Issue[]): DocumentFragment {
  type Range = { start: number; end: number; issue: Issue };
  const ranges: Range[] = [];
  for (const i of issues) {
    const needle = i.original.trim();
    if (needle.length < 2) continue;
    let from = 0;
    let idx: number;
    while ((idx = text.indexOf(needle, from)) !== -1) {
      const r = { start: idx, end: idx + needle.length, issue: i };
      if (!ranges.some((x) => r.start < x.end && x.start < r.end)) ranges.push(r);
      from = idx + needle.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const r of ranges) {
    frag.append(text.slice(pos, r.start));
    const original = text.slice(r.start, r.end);
    const fix = r.issue.suggestion;
    if (r.issue.severity === "error" && fix && fix !== "?" && fix !== original) {
      frag.append(el("span", { class: "mk-del", textContent: original, title: r.issue.explanation }), el("span", { class: "mk-ins", textContent: fix }));
    } else {
      frag.append(el("span", { class: r.issue.severity === "suggestion" ? "mk-s" : "mk-q", textContent: original, title: r.issue.explanation }));
    }
    pos = r.end;
  }
  frag.append(text.slice(pos));
  return frag;
}

interface HistoryEntry {
  at: number;
  result: ProofResult;
}
function loadHistory(): HistoryEntry[] {
  try {
    const v = JSON.parse(settings.raw.get("pp.history") || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveHistory(result: ProofResult) {
  settings.raw.set("pp.history", JSON.stringify([{ at: Date.now(), result }, ...loadHistory()].slice(0, 15)));
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  historySection.hidden = list.length === 0;
  historyList.replaceChildren(
    ...list.map((entry) => {
      const errs = entry.result.issues.filter((i) => i.severity === "error").length;
      const first = entry.result.transcription.replace(/\[Page \d+\]\s*/g, "").trim().split("\n")[0].slice(0, 60);
      const btn = el(
        "button",
        { class: "row-btn" },
        el(
          "span",
          { class: "grow" },
          el("span", { class: "t", textContent: first || "(no text)" }),
          el("span", { class: "meta", textContent: new Date(entry.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) }),
        ),
        el("span", { class: `tag ${errs ? "m" : "c"}`, textContent: errs ? plural(errs, "mistake") : "Clean" }),
        iconEl("chevron", 18, "chev"),
      );
      btn.onclick = () => renderResult(entry.result);
      return el("li", {}, btn);
    }),
  );
}

function showError(msg: string) {
  errorCard.textContent = msg;
  show(errorCard);
}
