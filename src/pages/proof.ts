import { proofread, ProofError, type Issue, type ProofResult } from "../proof";
import { proofreadOffline } from "../offline";
import { ocrBase64 } from "../ocr";
import { $, show, hide, el, settings, prepareImage, copyText, type PreparedImage } from "../util";
import { iconEl } from "../icons";

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
  const has = picked.length > 0;
  $("captureSlot").hidden = has;
  thumbs.hidden = !has;
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
const SEVERITY_LABEL = { error: "Fix", warning: "Check", suggestion: "Idea" } as const;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

function renderResult(r: ProofResult, engine?: "offline" | "claude") {
  const issues = [...r.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { error: 0, warning: 0, suggestion: 0 };
  issues.forEach((i) => counts[i.severity]++);
  const clean = counts.error === 0 && counts.warning === 0;
  const state = clean ? "ok" : counts.error ? "bad" : "warn";
  const headline = clean
    ? "Ready to print"
    : counts.error
      ? `Fix ${plural(counts.error, "mistake")} before printing`
      : `Double-check ${plural(counts.warning, "thing")}`;

  summaryEl.className = `panel verdict ${state}`;
  const text = el("div", { class: "grow" }, el("h2", { textContent: headline }), el("p", { textContent: r.summary }));
  if (engine === "offline" && settings.apiKey) {
    const b = el("button", { class: "btn small", textContent: "Also run the Claude check" });
    b.onclick = () => {
      settings.engine = "claude";
      renderEngine();
      runCheck();
    };
    text.append(b);
  }
  const kpi = (n: number, label: string, hot: boolean) =>
    el("div", { class: "kpi" }, el("div", { class: `v ${n === 0 ? "zero" : hot ? "hot" : ""}`, textContent: String(n) }), el("div", { class: "l", textContent: label }));
  summaryEl.replaceChildren(
    el("div", { class: "verdict-top" }, el("div", { class: "verdict-mark" }, iconEl(clean ? "check" : "alert", 22)), text),
    el("div", { class: "kpis" }, kpi(counts.error, "Mistakes", true), kpi(counts.warning, "To check", false), kpi(counts.suggestion, "Ideas", false)),
  );

  $("issueCount").textContent = issues.length ? plural(issues.length, "item") : "";
  issuesEl.replaceChildren(...(issues.length ? issues.map(renderIssue) : [el("li", { class: "empty-row", textContent: "Nothing to correct." })]));
  transcriptionEl.replaceChildren(markUp(r.transcription, issues));
  correctedEl.textContent = r.corrected_text;
  $<HTMLButtonElement>("copyBtn").onclick = (e) => copyText(e.currentTarget as HTMLButtonElement, r.corrected_text);

  show(results);
  summaryEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderIssue(i: Issue): HTMLElement {
  const top = el(
    "div",
    { class: "issue-top" },
    el("span", { class: `pill ${i.severity}`, textContent: SEVERITY_LABEL[i.severity] }),
    el("span", { class: "pill cat", textContent: i.category }),
  );
  if (i.location) top.append(el("span", { class: "loc", textContent: i.location }));
  const li = el("li", {}, top);
  if (i.original) {
    li.append(
      el(
        "div",
        { class: "change" },
        el("del", { textContent: i.original }),
        el("span", { class: "arrow", textContent: "→" }),
        el("ins", { textContent: i.suggestion && i.suggestion !== "?" ? i.suggestion : "check this" }),
      ),
    );
  }
  li.append(el("p", { class: "why", textContent: i.explanation }));
  return li;
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
        el("span", { class: `pill ${errs ? "error" : "positive"}`, textContent: errs ? plural(errs, "mistake") : "Clean" }),
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
