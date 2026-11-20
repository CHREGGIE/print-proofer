// The Android app uses Google ML Kit for text and barcode reading, so the browser engines
// (Tesseract ~11 MB, ZXing ~1 MB) are removed from the copy of the web app inside the
// Android project (not from dist/).
import { rmSync } from "node:fs";
for (const dir of ["tesseract", "zxing"]) rmSync(`android/app/src/main/assets/public/vendor/${dir}`, { recursive: true, force: true });
console.log("removed browser OCR and barcode engines from the Android copy");
