import "@fontsource/anton/latin-400.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./style.css";
import { hydrateIcons } from "./icons";
import { $, settings } from "./util";
import { isNative, NativeOcr } from "./native";
import { initProof, addImages, addSharedText, proofImages, proofText } from "./pages/proof";
import { initShots, showShots } from "./pages/shots";
import { initVideo } from "./pages/video";
import { initComp, showComp } from "./pages/comp";
import { initColors } from "./pages/colors";

hydrateIcons();

// ---------- tabs ----------
function showPage(page: string) {
  document.querySelectorAll<HTMLElement>(".page").forEach((p) => (p.hidden = p.id !== `page-${page}`));
  document.querySelectorAll<HTMLButtonElement>(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  window.scrollTo({ top: 0 });
  if (page === "shots") showShots();
  if (page === "comp") showComp();
  settings.raw.set("pp.tab", page);
}
document.querySelectorAll<HTMLButtonElement>(".tabbar button").forEach((b) => (b.onclick = () => showPage(b.dataset.page!)));
document.querySelector<HTMLAnchorElement>(".brand")!.onclick = (e) => {
  e.preventDefault();
  showPage("proof");
};

// ---------- settings ----------
const dialog = $<HTMLDialogElement>("settingsDialog");
function openSettings() {
  $<HTMLInputElement>("keyInput").value = settings.apiKey;
  $<HTMLTextAreaElement>("defaultNotesInput").value = settings.notes;
  $<HTMLInputElement>("ltToggle").checked = settings.languageTool;
  $<HTMLInputElement>("autoIndexToggle").checked = settings.autoIndex;
  $<HTMLInputElement>("autoProofToggle").checked = settings.autoProof;
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

  const proofNew = $<HTMLInputElement>("autoProofToggle").checked;
  if (isNative && proofNew !== settings.autoProof) {
    if (proofNew) {
      if (!(await NativeOcr.requestPhotoAccess()).granted) return alert("Photo access is needed to read new screenshots.");
      if (!(await NativeOcr.requestNotifications()).granted) return alert("Allow notifications so the app can tell you when it spots a mistake.");
    }
    await NativeOcr.setAutoProof({ enabled: proofNew }).catch(() => {});
  }
  settings.autoProof = proofNew;
});
document.querySelectorAll<HTMLElement>(".native-only").forEach((e) => (e.hidden = !isNative));

// ---------- pages ----------
initProof({ openSettings });
initShots({ proofImage: async (blob) => (showPage("proof"), proofImages([blob])), proofText: (t) => (showPage("proof"), proofText(t)) });
initVideo();
initComp();
initColors();
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

// A tapped "possible mistakes" notification: open that screenshot in Proof and check it.
async function proofScreenshot(id: number) {
  if (id < 0) return;
  try {
    const { base64 } = await NativeOcr.getImage({ id });
    showPage("proof");
    await proofImages([b64ToBlob(base64)]);
  } catch {
    /* screenshot deleted meanwhile */
  }
}

if (isNative) {
  NativeOcr.getPendingProof().then((r) => proofScreenshot(r.id)).catch(() => {});
  NativeOcr.addListener("proofRequest", (r) => proofScreenshot(r.id));
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
