// Text recognition that runs on the device: Google ML Kit inside the Android app,
// Tesseract (self-hosted WebAssembly) in a browser. No account, no API key.
import { isNative, NativeOcr } from "./native";
import type { Worker } from "tesseract.js";

let tesseract: Promise<Worker> | null = null;

function getTesseract(): Promise<Worker> {
  tesseract ??= import("tesseract.js").then(({ createWorker }) =>
    createWorker("eng", 1, {
      workerPath: new URL("./vendor/tesseract/worker.min.js", location.href).href,
      corePath: new URL("./vendor/tesseract/core/", location.href).href,
      langPath: new URL("./vendor/tesseract/lang/", location.href).href,
      gzip: true,
    }),
  );
  return tesseract;
}

/** OCR a JPEG/PNG given as base64 (no data: prefix). Returns plain text with line breaks. */
export async function ocrBase64(base64: string): Promise<string> {
  if (isNative) {
    const { text } = await NativeOcr.recognize({ base64 });
    return text;
  }
  const worker = await getTesseract();
  const { data } = await worker.recognize(`data:image/jpeg;base64,${base64}`);
  // Tesseract returns some low-confidence junk lines for photos; drop those.
  return data.text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 1 && /[A-Za-z0-9]/.test(l))
    .join("\n");
}

export async function ocrCanvas(canvas: HTMLCanvasElement): Promise<string> {
  return ocrBase64(canvas.toDataURL("image/jpeg", 0.9).split(",")[1]);
}
