// Colour palette extraction for print, on the device. Same method as tools/palette.py:
// k-means++ in Lab (so "close" means close to the eye), merge near-duplicates, drop the soft
// blends where two colours meet (anti-aliasing, JPEG blur), then give HEX / RGB / CMYK, a plain
// name and print notes.

export type RGB = [number, number, number];
type Lab = [number, number, number];

export interface Swatch {
  hex: string;
  rgb: RGB;
  cmyk: [number, number, number, number];
  share: number; // % of the image
  name: string;
  notes: string[];
}

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function rgbToLab([r8, g8, b8]: RGB): Lab {
  const r = lin(r8 / 255), g = lin(g8 / 255), b = lin(b8 / 255);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb([L, a, b]: Lab): RGB {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
  const enc = (c: number) => {
    c = Math.max(0, Math.min(1, c));
    return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
  };
  return [
    enc(3.2406 * x - 1.5372 * y - 0.4986 * z),
    enc(-0.9689 * x + 1.8758 * y + 0.0415 * z),
    enc(0.0557 * x - 0.204 * y + 1.057 * z),
  ];
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function distToSegment(p: readonly number[], a: readonly number[], b: readonly number[]) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const denom = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / denom));
  return dist(p, [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]]);
}

export function toCmyk([r8, g8, b8]: RGB): [number, number, number, number] {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const k = 1 - Math.max(r, g, b);
  if (k >= 0.999) return [0, 0, 0, 100];
  const c = (1 - r - k) / (1 - k), m = (1 - g - k) / (1 - k), y = (1 - b - k) / (1 - k);
  return [c, m, y, k].map((v) => Math.round(v * 100)) as [number, number, number, number];
}

export const toHex = (rgb: RGB) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

function hsl([r8, g8, b8]: RGB) {
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l, v: max };
}

const HUES: [number, string][] = [
  [15, "red"], [40, "orange"], [65, "yellow"], [90, "lime"], [150, "green"], [185, "teal"],
  [205, "cyan"], [250, "blue"], [280, "violet"], [320, "purple"], [345, "pink"], [361, "red"],
];

export function colourName(rgb: RGB): string {
  const { h, s, l } = hsl(rgb);
  if (l > 0.94) return "white";
  if (l < 0.08) return "black";
  if (s < 0.12) return l > 0.7 ? "light grey" : l < 0.3 ? "dark grey" : "grey";
  if (l > 0.86 && s < 0.5) return "off-white";
  let hue = HUES.find(([lim]) => h < lim)![1];
  if (hue === "orange" && l < 0.4) hue = "brown";
  const tone = l < 0.3 ? "dark " : l > 0.78 ? "pale " : "";
  const vivid = s > 0.75 && l > 0.35 && l < 0.65 ? "vivid " : s < 0.35 ? "muted " : "";
  return `${tone}${vivid}${hue}`;
}

export function printNotes(rgb: RGB): string[] {
  const max = Math.max(...rgb) / 255, min = Math.min(...rgb) / 255;
  const v = max, sv = max === 0 ? 0 : (max - min) / max;
  const { h } = hsl(rgb);
  const notes: string[] = [];
  if (sv > 0.8 && v > 0.8 && ((h >= 90 && h <= 160) || (h >= 200 && h <= 300) || (h >= 20 && h <= 45))) {
    notes.push("Bright screen colour: will print duller in CMYK. Ask for a proof or a spot colour.");
  }
  if (v < 0.15) notes.push("Near black: for big areas use rich black (C60 M40 Y40 K100); keep small text 100% K.");
  if (sv < 0.08 && v >= 0.15 && v < 0.9) notes.push("Grey: print it with K only so it stays neutral.");
  return notes;
}

/** Seeded random so the same picture always gives the same palette. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function kmeans(labs: Lab[], k: number) {
  const rnd = rng(7);
  const centres: Lab[] = [labs[Math.floor(rnd() * labs.length)]];
  while (centres.length < k) {
    const d2 = labs.map((p) => Math.min(...centres.map((c) => dist(p, c) ** 2)));
    const total = d2.reduce((s, v) => s + v, 0);
    if (!total) break;
    let r = rnd() * total;
    const i = d2.findIndex((d) => (r -= d) <= 0);
    centres.push(labs[i < 0 ? labs.length - 1 : i]);
  }
  const nearest = (p: Lab) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < centres.length; i++) {
      const d = dist(p, centres[i]);
      if (d < bd) (bd = d), (best = i);
    }
    return best;
  };
  let assign = new Int32Array(labs.length);
  for (let it = 0; it < 12; it++) {
    assign = Int32Array.from(labs, nearest);
    const sums = centres.map(() => [0, 0, 0, 0]);
    labs.forEach((p, i) => {
      const s = sums[assign[i]];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    });
    let moved = 0;
    sums.forEach((s, i) => {
      if (!s[3]) return;
      const n: Lab = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
      moved = Math.max(moved, dist(n, centres[i]));
      centres[i] = n;
    });
    if (moved < 0.5) break;
  }
  assign = Int32Array.from(labs, nearest);
  const counts = centres.map(() => 0);
  assign.forEach((a) => counts[a]++);
  return centres.map((lab, i) => ({ lab, count: counts[i] }));
}

/** Pixels from an image, skipping transparency; optionally drops the colour around the edge. */
function samplePixels(img: CanvasImageSource, w: number, h: number, keepBackground: boolean) {
  const scale = Math.min(1, 320 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;
  const at = (x: number, y: number): RGB => {
    const i = (y * cw + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  let px: RGB[] = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 128) px.push([data[i], data[i + 1], data[i + 2]]);
  let bg: RGB | null = null;
  if (!keepBackground) {
    const edge: string[] = [];
    for (let x = 0; x < cw; x++) edge.push(at(x, 0).join(), at(x, ch - 1).join());
    for (let y = 0; y < ch; y++) edge.push(at(0, y).join(), at(cw - 1, y).join());
    const tally = new Map<string, number>();
    edge.forEach((e) => tally.set(e, (tally.get(e) ?? 0) + 1));
    bg = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number) as RGB;
    const bgLab = rgbToLab(bg);
    const kept = px.filter((p) => dist(rgbToLab(p), bgLab) > 12);
    if (kept.length) px = kept;
  }
  if (px.length > 9000) {
    const rnd = rng(1);
    for (let i = px.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [px[i], px[j]] = [px[j], px[i]];
    }
    px = px.slice(0, 9000);
  }
  return { px, bg };
}

interface Group {
  lab: Lab;
  count: number;
}

function isEdgeBlend(m: Group, all: Group[], total: number, anchors: Lab[]): boolean {
  const share = m.count / total;
  if (share >= 0.15) return false;
  const rgb = labToRgb(m.lab);
  const others = all.filter((o) => o !== m);
  const ends = [...others.map((o) => o.lab), ...anchors];
  for (let i = 0; i < ends.length; i++)
    for (let j = i + 1; j < ends.length; j++) if (distToSegment(rgb, labToRgb(ends[i]), labToRgb(ends[j])) < 8) return true;
  if (share >= 0.04) return false;
  const big = [...others.filter((o) => o.count > 2 * m.count).map((o) => o.lab), ...anchors];
  for (let i = 0; i < big.length; i++)
    for (let j = i + 1; j < big.length; j++)
      if (distToSegment(m.lab, big[i], big[j]) < 7 || distToSegment(rgb, labToRgb(big[i]), labToRgb(big[j])) < 22) return true;
  return false;
}

export function extractPalette(img: CanvasImageSource, w: number, h: number, n = 6, keepBackground = true): Swatch[] {
  const { px, bg } = samplePixels(img, w, h, keepBackground);
  if (!px.length) return [];
  const labs = px.map(rgbToLab);
  const distinct = new Set(px.map((p) => p.join())).size;
  const clusters = kmeans(labs, Math.min(n + 3, distinct));
  const merged: Group[] = [];
  for (const c of clusters.sort((a, b) => b.count - a.count)) {
    const hit = merged.find((m) => dist(c.lab, m.lab) < 10);
    if (hit) {
      const t = hit.count + c.count;
      hit.lab = hit.lab.map((v, i) => (v * hit.count + c.lab[i] * c.count) / t) as Lab;
      hit.count = t;
    } else merged.push({ lab: [...c.lab] as Lab, count: c.count });
  }
  let kept = merged.filter((m) => m.count / labs.length >= 0.005).sort((a, b) => b.count - a.count);
  const anchors = bg ? [rgbToLab(bg)] : [];
  kept = kept.filter((m) => !isEdgeBlend(m, kept, labs.length, anchors));
  return kept.slice(0, n).map((m) => {
    const rgb = labToRgb(m.lab);
    return {
      hex: toHex(rgb),
      rgb,
      cmyk: toCmyk(rgb),
      share: Math.round((1000 * m.count) / labs.length) / 10,
      name: colourName(rgb),
      notes: printNotes(rgb),
    };
  });
}
