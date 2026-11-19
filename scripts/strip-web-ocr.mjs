// The Android app uses Google ML Kit for OCR, so the browser OCR engine
// (Tesseract, ~11 MB) is removed from the copy of the web app bundled in the APK.
import { rmSync } from "node:fs";
rmSync("dist/vendor/tesseract", { recursive: true, force: true });
console.log("removed browser OCR engine from Android build");
