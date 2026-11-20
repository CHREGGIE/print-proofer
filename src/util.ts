// Shared helpers: DOM, settings storage, image resizing.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const show = (el: HTMLElement) => (el.hidden = false);
export const hide = (el: HTMLElement) => (el.hidden = true);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) node.className = cls;
  Object.assign(node, rest);
  node.append(...children);
  return node;
}

// ---------- settings (localStorage, never throws) ----------
const get = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const set = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked or full */
  }
};

export const settings = {
  get apiKey() { return get("pp.apiKey"); },
  set apiKey(v: string) { set("pp.apiKey", v); },
  get notes() { return get("pp.defaultNotes"); },
  set notes(v: string) { set("pp.defaultNotes", v); },
  get engine(): "offline" | "claude" { return get("pp.engine") === "claude" ? "claude" : "offline"; },
  set engine(v: "offline" | "claude") { set("pp.engine", v); },
  get languageTool() { return get("pp.languageTool") === "1"; },
  set languageTool(v: boolean) { set("pp.languageTool", v ? "1" : ""); },
  get autoIndex() { return get("pp.autoIndex") === "1"; },
  set autoIndex(v: boolean) { set("pp.autoIndex", v ? "1" : ""); },
  get autoProof() { return get("pp.autoProof") === "1"; },
  set autoProof(v: boolean) { set("pp.autoProof", v ? "1" : ""); },
  raw: { get, set },
};

// ---------- images ----------
export interface PreparedImage {
  base64: string; // JPEG, no data: prefix
  dataUrl: string;
}

/** Downscale + flatten to JPEG. maxEdge keeps small print legible within API/OCR limits. */
export async function prepareImage(file: Blob, maxEdge = 2400, quality = 0.9): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);
  const canvas = drawScaled(bitmap, bitmap.width, bitmap.height, maxEdge);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { base64: dataUrl.split(",")[1], dataUrl };
}

export function drawScaled(src: CanvasImageSource, w: number, h: number, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Small JPEG data URL for lists/timelines. */
export async function thumbnail(dataUrl: string, maxEdge = 360): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return drawScaled(img, img.naturalWidth, img.naturalHeight, maxEdge).toDataURL("image/jpeg", 0.75);
}

export const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export async function copyText(btn: HTMLButtonElement, text: string) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied!";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = label), 1500);
}
