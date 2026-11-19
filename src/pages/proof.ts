import { proofread, ProofError, type Issue, type ProofResult } from "../proof";
import { proofreadOffline } from "../offline";
import { ocrBase64 } from "../ocr";
import { $, show, hide, el, settings, prepareImage, copyText, type PreparedImage } from "../util";

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
  $("newBtn").onclick = () => {
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
}

function renderEngine() {
  document.querySelectorAll<HTMLButtonElement>("[data-engine]").forEach((b) => {
    const on = b.dataset.engine === settings.engine;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
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
  thumbs.replaceChildren(
    ...picked.map((p, i) => {
      const rm = el("button", { class: "thumb-x", textContent: "✕", ariaLabel: `Remove page ${i + 1}` });
      rm.onclick = () => {
        picked.splice(i, 1);
        renderThumbs();
      };
      return el("div", { class: "thumb" }, el("img", { src: p.dataUrl, alt: `Page ${i + 1}` }), rm);
    }),
  );
  updateCheckBtn();
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
        const t = await ocrBase64(picked[i].base64);
        parts.push(picked.length > 1 ? `[Page ${i + 1}]\n${t}` : t);
      }
      if (textInput.value.trim()) parts.push(textInput.value.trim());
      statusText.textContent = steps[1];
      result = await proofreadOffline(parts.join("\n\n"), { notes, languageTool: settings.languageTool });
      if (controller.signal.aborted) throw new ProofError("Cancelled.");
    }
    renderResult(result, useClaude ? "claude" : "offline");
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
const SEVERITY_LABEL = { error: "Error", warning: "Check", suggestion: "Suggestion" } as const;

function renderResult(r: ProofResult, engine?: "offline" | "claude") {
  const issues = [...r.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { error: 0, warning: 0, suggestion: 0 };
  issues.forEach((i) => counts[i.severity]++);
  const clean = counts.error === 0 && counts.warning === 0;

  summaryEl.className = `card summary ${clean ? "ok" : counts.error ? "bad" : "warn"}`;
  const counters = el("div", { class: "counters" });
  for (const sev of ["error", "warning", "suggestion"] as const) {
    counters.append(el("span", { class: `pill ${sev}`, textContent: `${counts[sev]} ${SEVERITY_LABEL[sev].toLowerCase()}${counts[sev] === 1 ? "" : "s"}` }));
  }
  summaryEl.replaceChildren(
    el("h2", { textContent: clean ? "✅ Ready to print" : counts.error ? "❌ Fix before printing" : "⚠️ Double-check these" }),
    counters,
    el("p", { textContent: r.summary }),
  );
  if (engine === "offline" && settings.apiKey) {
    const b = el("button", { class: "btn small", textContent: "Run Claude deep check too" });
    b.onclick = () => {
      settings.engine = "claude";
      renderEngine();
      runCheck();
    };
    summaryEl.append(b);
  }

  issuesEl.replaceChildren(...issues.map(renderIssue));
  transcriptionEl.replaceChildren(highlight(r.transcription, issues));
  correctedEl.textContent = r.corrected_text;
  $<HTMLButtonElement>("copyBtn").onclick = (e) => copyText(e.currentTarget as HTMLButtonElement, r.corrected_text);

  show(results);
  summaryEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderIssue(i: Issue): HTMLElement {
  const change = i.original
    ? el("div", { class: "change" }, el("del", { textContent: i.original }), el("span", { class: "arrow", textContent: "→" }), el("ins", { textContent: i.suggestion || "—" }))
    : el("div");
  return el(
    "article",
    { class: `card issue ${i.severity}` },
    el(
      "div",
      { class: "issue-head" },
      el("span", { class: `pill ${i.severity}`, textContent: SEVERITY_LABEL[i.severity] }),
      el("span", { class: "cat", textContent: i.category }),
      el("span", { class: "loc", textContent: i.location }),
    ),
    change,
    el("p", { class: "why", textContent: i.explanation }),
  );
}

function highlight(text: string, issues: Issue[]): DocumentFragment {
  type Range = { start: number; end: number; sev: Issue["severity"] };
  const ranges: Range[] = [];
  for (const i of issues) {
    const needle = i.original.trim();
    if (needle.length < 2) continue;
    let from = 0;
    let idx: number;
    while ((idx = text.indexOf(needle, from)) !== -1) {
      const r = { start: idx, end: idx + needle.length, sev: i.severity };
      if (!ranges.some((x) => r.start < x.end && x.start < r.end)) ranges.push(r);
      from = idx + needle.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const r of ranges) {
    frag.append(text.slice(pos, r.start), el("mark", { class: r.sev, textContent: text.slice(r.start, r.end) }));
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
        { class: "history-item" },
        el("span", { textContent: first || "(no text)" }),
        el("span", { class: "hint", textContent: `${new Date(entry.at).toLocaleString()} · ${errs} error${errs === 1 ? "" : "s"}` }),
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
