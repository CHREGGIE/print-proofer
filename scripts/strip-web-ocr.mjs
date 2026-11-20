// The Android app uses Google ML Kit for OCR, so the browser OCR engine (Tesseract, ~11 MB)
// is removed from the copy of the web app inside the Android project (not from dist/).
import { rmSync } from "node:fs";
rmSync("android/app/src/main/assets/public/vendor/tesseract", { recursive: true, force: true });
console.log("removed browser OCR engine from the Android copy");
