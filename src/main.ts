import "./style.css";
import { proofread, ProofError, type ProofImage, type ProofResult, type Issue } from "./proof";

// ---------- storage helpers (never throw) ----------
const store = {
  get(key: string): string {
    try {
      return localStorage.getItem(key) ?? "";
    } catch {
      return "";
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage full or blocked */
    }
  },
};
const KEY_API = "pp.apiKey";
const KEY_NOTES = "pp.defaultNotes";
const KEY_HISTORY = "pp.history";

// ---------- elements ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cameraInput = $<HTMLInputElement>("cameraInput");
const fileInput = $<HTMLInputElement>("fileInput");
const thumbs = $("thumbs");
const textInput = $<HTMLTextAreaElement>("textInput");
const notesInput = $<HTMLTextAreaElement>("notesInput");
const checkBtn = $<HTMLButtonElement>("checkBtn");
const statusCard = $("statusCard");
const statusText = $("statusText");
const elapsed = $("elapsed");
const cancelBtn = $<HTMLButtonElement>("cancelBtn");
const errorCard = $("errorCard");
const results = $("results");
const summaryEl = $("summary");
const issuesEl = $("issues");
const transcriptionEl = $("transcription");
const correctedEl = $("corrected");
const copyBtn = $<HTMLButtonElement>("copyBtn");
const newBtn = $<HTMLButtonElement>("newBtn");
const setupCard = $("setupCard");
const settingsDialog = $<HTMLDialogElement>("settingsDialog");
const keyInput = $<HTMLInputElement>("keyInput");
const defaultNotesInput = $<HTMLTextAreaElement>("defaultNotesInput");
const historySection = $("historySection");
const historyList = $("historyList");

// ---------- state ----------
interface Picked {
  image: ProofImage;
  previewUrl: string;
}
let picked: Picked[] = [];
let controller: AbortController | null = null;

// ---------- image handling ----------
const MAX_EDGE = 2400; // keeps small print legible while staying well under API size limits

async function prepareImage(file: Blob): Promise<Picked> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // flatten transparency (screenshots with alpha)
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  return {
    image: { mediaType: "image/jpeg", base64: dataUrl.split(",")[1] },
    previewUrl: dataUrl,
  };
}

async function addFiles(files: Iterable<Blob>) {
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

function renderThumbs() {
  thumbs.replaceChildren(
    ...picked.map((p, i) => {
      const wrap = document.createElement("div");
      wrap.className = "thumb";
      const img = document.createElement("img");
      img.src = p.previewUrl;
      img.alt = `Page ${i + 1}`;
      const rm = document.createElement("button");
      rm.className = "thumb-x";
      rm.setAttribute("aria-label", `Remove page ${i + 1}`);
      rm.textContent = "✕";
      rm.onclick = () => {
        picked.splice(i, 1);
        renderThumbs();
      };
      wrap.append(img, rm);
      return wrap;
    }),
  );
  updateCheckBtn();
}

function updateCheckBtn() {
  checkBtn.disabled = picked.length === 0 && !textInput.value.trim();
}

cameraInput.onchange = () => {
  if (cameraInput.files) addFiles(cameraInput.files);
  cameraInput.value = "";
};
fileInput.onchange = () => {
  if (fileInput.files) addFiles(fileInput.files);
  fileInput.value = "";
};
textInput.oninput = updateCheckBtn;

// Paste an image from the clipboard (handy on desktop / tablets)
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) addFiles(files);
});

// ---------- run check ----------
checkBtn.onclick = async () => {
  const apiKey = store.get(KEY_API);
  if (!apiKey) {
    openSettings();
    return;
  }
  hide(errorCard);
  hide(results);
  show(statusCard);
  checkBtn.disabled = true;
  controller = new AbortController();

  const started = Date.now();
  const messages = [
    "Reading your proof…",
    "Checking spelling…",
    "Checking grammar & punctuation…",
    "Cross-checking names, dates & numbers…",
    "Looking at layout…",
    "Almost done…",
  ];
  statusText.textContent = messages[0];
  const timer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    elapsed.textContent = `${s}s`;
    statusText.textContent = messages[Math.min(messages.length - 1, Math.floor(s / 8))];
  }, 1000);

  const notes = [store.get(KEY_NOTES), notesInput.value].filter((n) => n.trim()).join("\n");
  try {
    const result = await proofread({
      apiKey,
      images: picked.map((p) => p.image),
      text: textInput.value,
      notes,
      signal: controller.signal,
    });
    renderResult(result);
    saveHistory(result);
  } catch (err) {
    showError(err instanceof ProofError ? err.message : `Something went wrong: ${String(err)}`);
  } finally {
    clearInterval(timer);
    elapsed.textContent = "";
    hide(statusCard);
    controller = null;
    updateCheckBtn();
  }
};

cancelBtn.onclick = () => controller?.abort();

newBtn.onclick = () => {
  picked = [];
  textInput.value = "";
  notesInput.value = "";
  renderThumbs();
  hide(results);
  hide(errorCard);
  window.scrollTo({ top: 0, behavior: "smooth" });
};

// ---------- render results ----------
const SEVERITY_ORDER = { error: 0, warning: 1, suggestion: 2 } as const;
const SEVERITY_LABEL = { error: "Error", warning: "Check", suggestion: "Suggestion" } as const;

function renderResult(r: ProofResult) {
  const issues = [...r.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const counts = { error: 0, warning: 0, suggestion: 0 };
  issues.forEach((i) => counts[i.severity]++);

  const clean = counts.error === 0 && counts.warning === 0;
  summaryEl.className = `card summary ${clean ? "ok" : counts.error ? "bad" : "warn"}`;
  summaryEl.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = clean ? "✅ Ready to print" : counts.error ? "❌ Fix before printing" : "⚠️ Double-check these";
  const counters = document.createElement("div");
  counters.className = "counters";
  for (const sev of ["error", "warning", "suggestion"] as const) {
    const c = document.createElement("span");
    c.className = `pill ${sev}`;
    c.textContent = `${counts[sev]} ${SEVERITY_LABEL[sev].toLowerCase()}${counts[sev] === 1 ? "" : "s"}`;
    counters.append(c);
  }
  const p = document.createElement("p");
  p.textContent = r.summary;
  summaryEl.append(h, counters, p);

  issuesEl.replaceChildren(...issues.map(renderIssue));
  transcriptionEl.replaceChildren(highlight(r.transcription, issues));
  correctedEl.textContent = r.corrected_text;
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(r.corrected_text);
      copyBtn.textContent = "Copied!";
    } catch {
      copyBtn.textContent = "Copy failed";
    }
    setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
  };

  show(results);
  summaryEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderIssue(i: Issue): HTMLElement {
  const card = document.createElement("article");
  card.className = `card issue ${i.severity}`;
  const head = document.createElement("div");
  head.className = "issue-head";
  const sev = document.createElement("span");
  sev.className = `pill ${i.severity}`;
  sev.textContent = SEVERITY_LABEL[i.severity];
  const cat = document.createElement("span");
  cat.className = "cat";
  cat.textContent = i.category;
  const loc = document.createElement("span");
  loc.className = "loc";
  loc.textContent = i.location;
  head.append(sev, cat, loc);

  const change = document.createElement("div");
  change.className = "change";
  const from = document.createElement("del");
  from.textContent = i.original || "—";
  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "→";
  const to = document.createElement("ins");
  to.textContent = i.suggestion || "—";
  change.append(from, arrow, to);

  const why = document.createElement("p");
  why.className = "why";
  why.textContent = i.explanation;
  card.append(head, change, why);
  return card;
}

/** Wrap each issue's original text in a <mark> within the transcription. */
function highlight(text: string, issues: Issue[]): DocumentFragment {
  type Range = { start: number; end: number; sev: Issue["severity"] };
  const ranges: Range[] = [];
  for (const i of issues) {
    const needle = i.original.trim();
    if (needle.length < 1) continue;
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
    frag.append(text.slice(pos, r.start));
    const m = document.createElement("mark");
    m.className = r.sev;
    m.textContent = text.slice(r.start, r.end);
    frag.append(m);
    pos = r.end;
  }
  frag.append(text.slice(pos));
  return frag;
}

// ---------- history ----------
interface HistoryEntry {
  at: number;
  result: ProofResult;
}

function loadHistory(): HistoryEntry[] {
  try {
    const v = JSON.parse(store.get(KEY_HISTORY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function saveHistory(result: ProofResult) {
  const list = [{ at: Date.now(), result }, ...loadHistory()].slice(0, 15);
  store.set(KEY_HISTORY, JSON.stringify(list));
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  historySection.hidden = list.length === 0;
  historyList.replaceChildren(
    ...list.map((entry) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "history-item";
      const errs = entry.result.issues.filter((i) => i.severity === "error").length;
      const first = entry.result.transcription.replace(/\[Page \d+\]\s*/g, "").trim().split("\n")[0].slice(0, 60);
      const title = document.createElement("span");
      title.textContent = first || "(no text)";
      const meta = document.createElement("span");
      meta.className = "hint";
      meta.textContent = `${new Date(entry.at).toLocaleString()} · ${errs} error${errs === 1 ? "" : "s"}`;
      btn.append(title, meta);
      btn.onclick = () => renderResult(entry.result);
      li.append(btn);
      return li;
    }),
  );
}

$("clearHistoryBtn").onclick = () => {
  store.set(KEY_HISTORY, "[]");
  renderHistory();
};

// ---------- settings ----------
function openSettings() {
  keyInput.value = store.get(KEY_API);
  defaultNotesInput.value = store.get(KEY_NOTES);
  settingsDialog.showModal();
}
$("settingsBtn").onclick = openSettings;
$("setupBtn").onclick = openSettings;
settingsDialog.addEventListener("close", () => {
  if (settingsDialog.returnValue === "save") {
    store.set(KEY_API, keyInput.value.trim());
    store.set(KEY_NOTES, defaultNotesInput.value);
  }
  refreshSetup();
});
function refreshSetup() {
  setupCard.hidden = !!store.get(KEY_API);
}

// ---------- misc ----------
function show(el: HTMLElement) {
  el.hidden = false;
}
function hide(el: HTMLElement) {
  el.hidden = true;
}
function showError(msg: string) {
  errorCard.textContent = msg;
  show(errorCard);
}

// Images shared to the app from Android's share sheet (see public/sw.js)
async function loadSharedFiles() {
  const params = new URLSearchParams(location.search);
  if (!params.has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("pp-shared");
    const reqs = await cache.keys();
    const blobs: Blob[] = [];
    for (const req of reqs) {
      const res = await cache.match(req);
      if (!res) continue;
      if (req.url.includes("shared-text")) {
        const t = await res.text();
        if (t.trim()) {
          textInput.value = t;
          ($("textDetails") as HTMLDetailsElement).open = true;
        }
      } else {
        blobs.push(await res.blob());
      }
      await cache.delete(req);
    }
    await addFiles(blobs);
    updateCheckBtn();
  } catch {
    /* nothing shared */
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

refreshSetup();
renderHistory();
loadSharedFiles();
