// Colors tab: extract a print palette from a picture, and sample any spot by tapping it.
import { extractPalette, toCmyk, toHex, colourName, printNotes, type RGB, type Swatch } from "../palette";
import { $, el, show, copyText } from "../util";
import { iconEl } from "../icons";

const canvas = $<HTMLCanvasElement>("palCanvas");
const list = $("palList");
let source: ImageBitmap | null = null;
let palette: Swatch[] = [];
let picked: (Swatch & { x: number; y: number })[] = [];

export function initColors() {
  for (const id of ["palCamera", "palFile"]) {
    const input = $<HTMLInputElement>(id);
    input.onchange = async () => {
      const f = input.files?.[0];
      input.value = "";
      if (f) await load(f);
    };
  }
  $<HTMLInputElement>("palNoBg").onchange = run;
  $<HTMLSelectElement>("palCount").onchange = run;
  canvas.onclick = (e) => sample(e);
  $("palCopy").onclick = (e) =>
    copyText(
      e.currentTarget as HTMLButtonElement,
      [...picked, ...palette]
        .map((s) => `${s.hex}  RGB ${s.rgb.join(",")}  CMYK ${s.cmyk.join("/")}  ${s.name}`)
        .join("\n"),
    );
}

async function load(file: Blob) {
  try {
    source?.close();
    source = await createImageBitmap(file);
  } catch {
    list.replaceChildren(el("li", { className: "why", textContent: "Couldn't open that image. Try a JPG or PNG." }));
    show($("palResults"));
    return;
  }
  picked = [];
  run();
  show($("palResults"));
  $("palResults").scrollIntoView({ behavior: "smooth", block: "start" });
}

function run() {
  if (!source) return;
  const n = Number($<HTMLSelectElement>("palCount").value) || 6;
  palette = extractPalette(source, source.width, source.height, n, !$<HTMLInputElement>("palNoBg").checked);
  draw();
  render();
}

/** Preview at screen resolution, with a registration mark on every sampled spot. */
function draw() {
  if (!source) return;
  const w = Math.min(source.width, 1200);
  const h = Math.round((source.height * w) / source.width);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  for (const p of picked) {
    const r = Math.max(8, w / 60);
    ctx.lineWidth = Math.max(2, w / 300);
    for (const [colour, width] of [["#000", ctx.lineWidth + 2], ["#fff", ctx.lineWidth]] as const) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.moveTo(p.x - r * 1.7, p.y);
      ctx.lineTo(p.x + r * 1.7, p.y);
      ctx.moveTo(p.x, p.y - r * 1.7);
      ctx.lineTo(p.x, p.y + r * 1.7);
      ctx.stroke();
    }
  }
  $("palBar").replaceChildren(
    ...palette.map((s) => {
      const seg = el("i", { title: `${s.hex} · ${s.share}%` });
      seg.style.background = s.hex;
      seg.style.flex = String(s.share);
      return seg;
    }),
  );
}

function sample(e: MouseEvent) {
  if (!source) return;
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
  // Average a small 5×5 patch so print dots / JPEG noise don't skew the reading.
  const tmp = document.createElement("canvas");
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const tctx = tmp.getContext("2d", { willReadFrequently: true })!;
  tctx.drawImage(source, 0, 0, tmp.width, tmp.height);
  const d = tctx.getImageData(Math.max(0, Math.round(x) - 2), Math.max(0, Math.round(y) - 2), 5, 5).data;
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) (sum[0] += d[i]), (sum[1] += d[i + 1]), (sum[2] += d[i + 2]), n++;
  if (!n) return;
  const rgb = sum.map((v) => Math.round(v / n)) as RGB;
  picked = [{ hex: toHex(rgb), rgb, cmyk: toCmyk(rgb), share: 0, name: colourName(rgb), notes: printNotes(rgb), x, y }, ...picked].slice(0, 4);
  draw();
  render();
}

function render() {
  const rows = [...picked.map((s) => row(s, true)), ...palette.map((s) => row(s, false))];
  list.replaceChildren(...(rows.length ? rows : [el("li", {}, el("span", { className: "why", textContent: "No colours found in this image." }))]));
}

function row(s: Swatch, isPicked: boolean): HTMLElement {
  const hex = el("button", { className: "hex", ariaLabel: `Copy ${s.hex}` }, s.hex, iconEl("copy", 16));
  hex.onclick = () => copyText(hex, s.hex);
  const head = el("div", { className: "swatch-head" }, hex);
  if (isPicked) head.append(el("span", { className: "tag k", textContent: "Picked" }));
  const info = el(
    "div",
    { className: "grow" },
    head,
    el("div", { className: "meta", textContent: isPicked ? s.name : `${s.name} · ${s.share}% of the image` }),
    el("div", { className: "vals" }, `RGB ${s.rgb.join(", ")}`, el("br"), `C${s.cmyk[0]} M${s.cmyk[1]} Y${s.cmyk[2]} K${s.cmyk[3]}`),
    ...s.notes.map((n) => el("p", { className: "note", textContent: n })),
  );
  const chip = el("div", { className: "chip-block" });
  chip.style.background = s.hex;
  return el("li", {}, chip, info);
}
