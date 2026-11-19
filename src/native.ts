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

  /** Screenshot memory */
  checkPhotoAccess(): Promise<{ granted: boolean }>;
  requestPhotoAccess(): Promise<{ granted: boolean }>;
  indexScreenshots(opts: { limit?: number }): Promise<{ added: number; total: number; remaining: number }>;
  getIndexed(opts: { sinceTaken?: number }): Promise<{ shots: IndexedShot[] }>;
  openImage(opts: { id: number }): Promise<void>;
  setAutoIndex(opts: { enabled: boolean }): Promise<void>;
  addListener(event: "indexProgress", fn: (e: { done: number; total: number }) => void): Promise<PluginListenerHandle>;

  /** Images shared to the app from other apps (Android share sheet). */
  getSharedImages(): Promise<{ images: string[] }>;
  addListener(event: "sharedImages", fn: (e: { images: string[] }) => void): Promise<PluginListenerHandle>;
}

export const isNative = Capacitor.isNativePlatform();
export const NativeOcr = registerPlugin<NativeOcrPlugin>("NativeOcr");
export const fileSrc = (path: string) => Capacitor.convertFileSrc(path);
