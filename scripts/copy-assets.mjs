// Copies offline assets (OCR engine, English model, spelling dictionary) into
// public/vendor so the app works with no internet and no CDN.
import { cpSync, mkdirSync, existsSync } from "node:fs";

const out = "public/vendor";
const files = [
  ["node_modules/tesseract.js/dist/worker.min.js", "tesseract/worker.min.js"],
  ["node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "tesseract/lang/eng.traineddata.gz"],
  ["node_modules/dictionary-en/index.aff", "dict/en.aff"],
  ["node_modules/dictionary-en/index.dic", "dict/en.dic"],
  ["node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", "zxing/zxing_reader.wasm"],
];
for (const v of ["tesseract-core-relaxedsimd-lstm", "tesseract-core-simd-lstm", "tesseract-core-lstm"]) {
  for (const ext of [".wasm.js"]) files.push([`node_modules/tesseract.js-core/${v}${ext}`, `tesseract/core/${v}${ext}`]);
}
for (const [src, dst] of files) {
  if (!existsSync(src)) continue;
  const target = `${out}/${dst}`;
  mkdirSync(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  cpSync(src, target);
}
console.log("offline assets ready in", out);
