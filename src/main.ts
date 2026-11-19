import "./style.css";
import { $, settings } from "./util";
import { isNative, NativeOcr } from "./native";
import { initProof, addImages, addSharedText } from "./pages/proof";
import { initShots, showShots } from "./pages/shots";
import { initVideo } from "./pages/video";
import { initComp, showComp } from "./pages/comp";

// ---------- tabs ----------
const TITLES: Record<string, string> = { proof: "Print Proofer", shots: "Screenshots", video: "Video text", comp: "Competitors" };
function showPage(page: string) {
  document.querySelectorAll<HTMLElement>(".page").forEach((p) => (p.hidden = p.id !== `page-${page}`));
  document.querySelectorAll<HTMLButtonElement>(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("pageTitle").textContent = TITLES[page];
  window.scrollTo({ top: 0 });
  if (page === "shots") showShots();
  if (page === "comp") showComp();
  settings.raw.set("pp.tab", page);
}
document.querySelectorAll<HTMLButtonElement>(".tabbar button").forEach((b) => (b.onclick = () => showPage(b.dataset.page!)));

// ---------- settings ----------
const dialog = $<HTMLDialogElement>("settingsDialog");
function openSettings() {
  $<HTMLInputElement>("keyInput").value = settings.apiKey;
  $<HTMLTextAreaElement>("defaultNotesInput").value = settings.notes;
  $<HTMLInputElement>("ltToggle").checked = settings.languageTool;
  $<HTMLInputElement>("autoIndexToggle").checked = settings.autoIndex;
  dialog.showModal();
}
$("settingsBtn").onclick = openSettings;
dialog.addEventListener("close", async () => {
  if (dialog.returnValue !== "save") return;
  settings.apiKey = $<HTMLInputElement>("keyInput").value.trim();
  settings.notes = $<HTMLTextAreaElement>("defaultNotesInput").value;
  settings.languageTool = $<HTMLInputElement>("ltToggle").checked;
  const auto = $<HTMLInputElement>("autoIndexToggle").checked;
  if (isNative && auto !== settings.autoIndex) {
    if (auto && !(await NativeOcr.requestPhotoAccess()).granted) {
      alert("Photo access is needed to index screenshots.");
      return;
    }
    await NativeOcr.setAutoIndex({ enabled: auto }).catch(() => {});
  }
  settings.autoIndex = auto;
});
document.querySelectorAll<HTMLElement>(".native-only").forEach((e) => (e.hidden = !isNative));

// ---------- pages ----------
initProof({ openSettings });
initShots();
initVideo();
initComp();
showPage(settings.raw.get("pp.tab") || "proof");

// ---------- things shared into the app ----------
function b64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}
async function receiveShared(images: string[]) {
  if (!images.length) return;
  showPage("proof");
  await addImages(images.map(b64ToBlob));
}

if (isNative) {
  NativeOcr.getSharedImages().then((r) => receiveShared(r.images)).catch(() => {});
  NativeOcr.addListener("sharedImages", (r) => receiveShared(r.images));
} else {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
  loadWebShared();
}

// Web (PWA) share target: public/sw.js stashes shared files in a cache.
async function loadWebShared() {
  if (!new URLSearchParams(location.search).has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("pp-shared");
    const blobs: Blob[] = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (res) {
        if (req.url.includes("shared-text")) addSharedText(await res.text());
        else blobs.push(await res.blob());
      }
      await cache.delete(req);
    }
    showPage("proof");
    await addImages(blobs);
  } catch {
    /* nothing shared */
  }
}
