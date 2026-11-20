// Bridge to the Android-only native code (android/app/src/main/java/.../NativeOcrPlugin.java).
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface IndexedShot {
  id: number; // MediaStore id
  name: string;
  taken: number; // ms since epoch
  text: string;
  thumb: string; // absolute file path of a small JPEG
}

export interface NativeOcrPlugin {
  /** On-device text recognition (Google ML Kit). */
  recognize(opts: { base64: string }): Promise<{ text: string }>;

  /** QR codes and barcodes (Google ML Kit). */
  scanCodes(opts: { base64: string }): Promise<{ codes: { format: string; raw: string; box?: { x: number; y: number; w: number; h: number } }[] }>;

  /** Read aloud with Android text-to-speech. Events report the word being spoken. */
  speak(opts: { text: string; id: string; rate: number }): Promise<void>;
  stopSpeaking(): Promise<void>;
  addListener(event: "speechRange", fn: (e: { id: string; start: number; end: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "speechDone", fn: (e: { id: string }) => void): Promise<PluginListenerHandle>;

  /** Screenshot memory */
  checkPhotoAccess(): Promise<{ granted: boolean }>;
  requestPhotoAccess(): Promise<{ granted: boolean }>;
  indexScreenshots(opts: { limit?: number }): Promise<{ added: number; total: number; remaining: number }>;
  getIndexed(opts: { sinceTaken?: number }): Promise<{ shots: IndexedShot[] }>;
  openImage(opts: { id: number }): Promise<void>;
  setAutoIndex(opts: { enabled: boolean }): Promise<void>;
  /** Notify about possible mistakes in new screenshots, seconds after each one is taken. */
  setAutoProof(opts: { enabled: boolean }): Promise<void>;
  requestNotifications(): Promise<{ granted: boolean }>;
  getImage(opts: { id: number }): Promise<{ base64: string }>;
  getPendingProof(): Promise<{ id: number }>;
  addListener(event: "proofRequest", fn: (e: { id: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: "indexProgress", fn: (e: { done: number; total: number }) => void): Promise<PluginListenerHandle>;

  /** Images shared to the app from other apps (Android share sheet). */
  getSharedImages(): Promise<{ images: string[] }>;
  addListener(event: "sharedImages", fn: (e: { images: string[] }) => void): Promise<PluginListenerHandle>;
}

export const isNative = Capacitor.isNativePlatform();
export const NativeOcr = registerPlugin<NativeOcrPlugin>("NativeOcr");
export const fileSrc = (path: string) => Capacitor.convertFileSrc(path);
