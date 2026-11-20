// Screenshot memory: every screenshot's text, searchable and auto-filed.
// In the Android app, screenshots are read from the gallery and OCR'd on-device
// (also in the background). In a browser, you add images by hand.
import { classify, extractEntities, type Category } from "../extract";
import { isNative, NativeOcr, fileSrc } from "../native";
import { ocrBase64 } from "../ocr";
import * as db from "../db";
import { $, el, prepareImage, thumbnail, fmtDate, copyText, settings } from "../util";
import { iconEl } from "../icons";

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
let ready: Promise<void> | null = null;
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
  $("shotFilters").querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
    b.onclick = () => {
      filter = b.dataset.cat as Category | "all";
      $("shotFilters").querySelectorAll(".tab").forEach((c) => c.classList.toggle("active", c === b));
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
  if (!ready) {
    ready = loadAll();
    await ready;
    if (isNative) scanNow(false);
  } else await ready;
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
        status.textContent = `${r.total} indexed${added ? `, ${added} new` : ""}${settings.autoIndex ? " · updates hourly" : ""}`;
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
  await (ready ??= loadAll());
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
  status.textContent = `${shots.length} indexed`;
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
  $("shotFilters").querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => {
    b.dataset.label ??= b.textContent!.trim();
    b.replaceChildren(b.dataset.label, el("span", { class: "n", textContent: String(counts[b.dataset.cat!]) }));
  });

  if (!shots.length) {
    list.replaceChildren(
      el("div", { class: "empty" }, isNative ? "No screenshots indexed yet. Tap Scan to read the ones on this phone." : "Add screenshots to make their text searchable. In the Android app this happens on its own."),
    );
    return;
  }
  if (!matches.length) {
    list.replaceChildren(el("div", { class: "empty" }, terms.length ? `Nothing matches “${search.value.trim()}”.` : "None in this group yet."));
    return;
  }
  const ul = el("ul", { class: "list" }, ...matches.slice(0, 120).map((s) => renderShot(s, terms)));
  list.replaceChildren(el("section", { class: "panel flush" }, ul));
  if (matches.length > 120) list.append(el("p", { class: "meta", textContent: `Showing 120 of ${matches.length}. Search to narrow it down.` }));
}

const TAG: Record<Category, [string, string]> = { receipt: ["c", "Receipt"], tracking: ["y", "Tracking"], code: ["m", "Code"], other: ["g", "Other"] };

function renderShot(s: Shot, terms: string[]): HTMLElement {
  const img = el("img", { src: s.thumb, alt: "", loading: "lazy" });
  if (s.mediaId != null) img.onclick = () => NativeOcr.openImage({ id: s.mediaId! });

  const actions = el("div", { class: "actions" });
  const copyBtn = (label: string, text: string) => {
    const b = el("button", { class: "btn small" }, iconEl("copy", 16), label);
    b.onclick = () => copyText(b, text);
    return b;
  };
  if (s.category === "tracking") {
    for (const t of extractEntities(s.text).tracking.slice(0, 1)) {
      actions.append(copyBtn("Copy number", t.number));
      if (TRACK_URL[t.carrier]) actions.append(el("a", { class: "btn small", href: TRACK_URL[t.carrier](t.number), target: "_blank", rel: "noopener" }, iconEl("external", 16), "Track"));
    }
  } else {
    actions.append(copyBtn(s.category === "code" ? "Copy code" : "Copy text", s.text));
  }
  const titleRow = el("div", { class: "shot-title" }, el("span", { class: "label", textContent: s.category === "other" ? s.label || "Screenshot" : s.label }));
  if (!s.mediaId) {
    const rm = el("button", { class: "icon-btn small", ariaLabel: "Remove" }, iconEl("trash", 18));
    rm.onclick = async () => {
      await db.del("shots", s.id);
      shots = shots.filter((x) => x.id !== s.id);
      render();
    };
    titleRow.append(rm);
  }

  return el(
    "li",
    { class: `shot-row ${s.category}` },
    img,
    el(
      "div",
      { class: "shot-main" },
      titleRow,
      el("div", { class: "shot-meta" }, el("span", { class: `tag ${TAG[s.category][0]}`, textContent: TAG[s.category][1] }), el("span", { class: "meta", textContent: fmtDate(s.taken) })),
      snippet(s.text, terms, s.category === "code"),
      actions,
    ),
  );
}

function snippet(text: string, terms: string[], mono: boolean): HTMLElement {
  const lower = text.toLowerCase();
  let start = 0;
  if (terms.length) start = Math.max(0, lower.indexOf(terms[0]) - 60);
  let piece = (start > 0 ? "…" : "") + text.slice(start, start + 220) + (text.length > start + 220 ? "…" : "");
  const out = el("p", { class: mono ? "snippet mono" : "snippet" });
  if (!terms.length) piece = text.slice(0, 220);
  if (!terms.length) {
    out.textContent = piece || "(no text found)";
    return out;
  }
  const alt = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const isHit = new RegExp(`^(?:${alt})$`, "i");
  for (const part of piece.split(new RegExp(`(${alt})`, "gi"))) out.append(isHit.test(part) ? el("mark", { class: "hit", textContent: part }) : part);
  return out;
}
