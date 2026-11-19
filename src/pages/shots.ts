// Screenshot memory: every screenshot's text, searchable and auto-filed.
// In the Android app, screenshots are read from the gallery and OCR'd on-device
// (also in the background). In a browser, you add images by hand.
import { classify, extractEntities, type Category } from "../extract";
import { isNative, NativeOcr, fileSrc } from "../native";
import { ocrBase64 } from "../ocr";
import * as db from "../db";
import { $, el, prepareImage, thumbnail, fmtDate, copyText, settings } from "../util";

interface Shot {
  id: string;
  mediaId?: number;
  name: string;
  taken: number;
  text: string;
  thumb: string; // URL usable in <img>
  category: Category;
  label: string;
}
interface StoredWebShot {
  id: string;
  name: string;
  taken: number;
  text: string;
  thumb: string;
}

let shots: Shot[] = [];
let filter: Category | "all" = "all";
let loaded = false;
let scanning = false;

const search = $<HTMLInputElement>("shotSearch");
const list = $("shotList");
const status = $("shotStatus");
const scanBtn = $<HTMLButtonElement>("shotScanBtn");

const TRACK_URL: Record<string, (n: string) => string> = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  FedEx: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  DHL: (n) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`,
};

export function initShots() {
  search.oninput = render;
  $("shotFilters").querySelectorAll<HTMLButtonElement>(".chip").forEach((b) => {
    b.onclick = () => {
      filter = b.dataset.cat as Category | "all";
      $("shotFilters").querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === b));
      render();
    };
  });
  scanBtn.hidden = !isNative;
  scanBtn.onclick = () => scanNow(true);
  const addInput = $<HTMLInputElement>("shotAddInput");
  addInput.onchange = async () => {
    if (addInput.files) await addWebImages([...addInput.files]);
    addInput.value = "";
  };
}

/** Called when the tab is opened. */
export async function showShots() {
  if (!loaded) {
    loaded = true;
    await loadAll();
    if (isNative) scanNow(false);
  }
  render();
}

function toShot(s: Omit<Shot, "category" | "label">): Shot {
  const c = classify(s.text);
  return { ...s, category: c.category, label: c.label };
}

async function loadAll() {
  const web = await db.all<StoredWebShot>("shots").catch(() => [] as StoredWebShot[]);
  shots = web.map((s) => toShot({ ...s }));
  if (isNative) {
    try {
      const { shots: nat } = await NativeOcr.getIndexed({});
      shots.push(...nat.map((s) => toShot({ id: `m${s.id}`, mediaId: s.id, name: s.name, taken: s.taken, text: s.text, thumb: fileSrc(s.thumb) })));
    } catch (e) {
      status.textContent = `Couldn't read the index: ${String(e)}`;
    }
  }
  shots.sort((a, b) => b.taken - a.taken);
}

async function scanNow(userAsked: boolean) {
  if (!isNative || scanning) return;
  let { granted } = await NativeOcr.checkPhotoAccess();
  if (!granted && userAsked) ({ granted } = await NativeOcr.requestPhotoAccess());
  if (!granted) {
    status.textContent = "Tap “Scan new screenshots” and allow photo access to index your screenshots.";
    return;
  }
  scanning = true;
  scanBtn.disabled = true;
  const sub = await NativeOcr.addListener("indexProgress", (e) => {
    status.textContent = `Reading screenshots… ${e.done} of ${e.total} new`;
  });
  try {
    let added = 0;
    for (;;) {
      const r = await NativeOcr.indexScreenshots({ limit: 200 });
      added += r.added;
      if (r.remaining === 0 || r.added === 0) {
        status.textContent = `${r.total} screenshots indexed${added ? ` (${added} new)` : ""}.${settings.autoIndex ? " New ones are added automatically." : ""}`;
        break;
      }
    }
    if (added) {
      await loadAll();
      render();
    }
  } catch (e) {
    status.textContent = `Indexing stopped: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    sub.remove();
    scanning = false;
    scanBtn.disabled = false;
  }
}

async function addWebImages(files: File[]) {
  let i = 0;
  for (const f of files) {
    i++;
    status.textContent = `Reading ${i} of ${files.length}…`;
    try {
      const img = await prepareImage(f, 2000);
      const text = await ocrBase64(img.base64);
      const stored: StoredWebShot = { id: db.newId(), name: f.name, taken: f.lastModified || Date.now(), text, thumb: await thumbnail(img.dataUrl) };
      await db.put("shots", stored);
      shots.push(toShot(stored));
    } catch (e) {
      status.textContent = `Couldn't read ${f.name}: ${String(e)}`;
    }
  }
  shots.sort((a, b) => b.taken - a.taken);
  status.textContent = `${shots.length} screenshots indexed.`;
  render();
}

function render() {
  const q = search.value.trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const matches = shots.filter((s) => {
    if (filter !== "all" && s.category !== filter) return false;
    const hay = `${s.text}\n${s.label}\n${s.name}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });

  const counts: Record<string, number> = { all: shots.length, receipt: 0, tracking: 0, code: 0, other: 0 };
  shots.forEach((s) => counts[s.category]++);
  $("shotFilters").querySelectorAll<HTMLButtonElement>(".chip").forEach((b) => {
    const base = b.textContent!.replace(/\s\(\d+\)$/, "");
    b.textContent = `${base} (${counts[b.dataset.cat!]})`;
  });

  if (!shots.length) {
    list.replaceChildren(
      el("div", { class: "card empty" }, isNative ? "No screenshots indexed yet. Tap “Scan new screenshots”." : "Add screenshots to make their text searchable. (In the Android app, your screenshots are indexed automatically.)"),
    );
    return;
  }
  if (!matches.length) {
    list.replaceChildren(el("div", { class: "card empty" }, "No screenshots match."));
    return;
  }
  list.replaceChildren(...matches.slice(0, 120).map((s) => renderShot(s, terms)));
  if (matches.length > 120) list.append(el("p", { class: "hint", textContent: `Showing 120 of ${matches.length}. Narrow your search to see more.` }));
}

const ICON: Record<Category, string> = { receipt: "🧾", tracking: "📦", code: "💻", other: "🗂️" };

function renderShot(s: Shot, terms: string[]): HTMLElement {
  const img = el("img", { src: s.thumb, alt: "", loading: "lazy" });
  if (s.mediaId != null) img.onclick = () => NativeOcr.openImage({ id: s.mediaId! });

  const actions = el("div", { class: "actions" });
  const copyAll = el("button", { class: "btn small", textContent: "Copy text" });
  copyAll.onclick = () => copyText(copyAll, s.text);
  actions.append(copyAll);

  if (s.category === "tracking") {
    for (const t of extractEntities(s.text).tracking.slice(0, 1)) {
      const c = el("button", { class: "btn small", textContent: "Copy #" });
      c.onclick = () => copyText(c, t.number);
      actions.append(c);
      if (TRACK_URL[t.carrier]) actions.append(el("a", { class: "btn small", href: TRACK_URL[t.carrier](t.number), target: "_blank", rel: "noopener", textContent: "Track" }));
    }
  }
  if (s.category === "code") {
    const c = el("button", { class: "btn small", textContent: "Copy code" });
    c.onclick = () => copyText(c, s.text);
    actions.replaceChildren(c);
  }
  if (!s.mediaId) {
    const rm = el("button", { class: "btn small", textContent: "Remove" });
    rm.onclick = async () => {
      await db.del("shots", s.id);
      shots = shots.filter((x) => x.id !== s.id);
      render();
    };
    actions.append(rm);
  }

  return el(
    "article",
    { class: "card shot" },
    img,
    el(
      "div",
      { class: "shot-body" },
      el("div", { class: "shot-head" }, el("span", { class: `tag ${s.category}`, textContent: `${ICON[s.category]} ${s.label || s.category}` })),
      el("div", { class: "hint", textContent: fmtDate(s.taken) }),
      snippet(s.text, terms, s.category === "code"),
      actions,
    ),
  );
}

function snippet(text: string, terms: string[], mono: boolean): HTMLElement {
  const lower = text.toLowerCase();
  let start = 0;
  if (terms.length) start = Math.max(0, lower.indexOf(terms[0]) - 60);
  const piece = (start > 0 ? "…" : "") + text.slice(start, start + 220) + (text.length > start + 220 ? "…" : "");
  const out = el("p", { class: mono ? "snippet mono" : "snippet" });
  if (!terms.length) {
    out.textContent = piece || "(no text found)";
    return out;
  }
  const alt = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const isHit = new RegExp(`^(?:${alt})$`, "i");
  for (const part of piece.split(new RegExp(`(${alt})`, "gi"))) out.append(isHit.test(part) ? el("mark", { class: "hit", textContent: part }) : part);
  return out;
}
