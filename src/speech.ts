// Read the proof aloud, one line at a time, reporting which characters are being spoken.
// Hearing the text is the old proofreader's trick for catching missing and doubled words.
// Android: native text-to-speech (offline). Browser: the Web Speech API.
import { isNative, NativeOcr } from "./native";

export interface ReadOptions {
  text: string;
  from: number; // character offset to start from
  rate: number; // 1 = normal
  onWord: (start: number, end: number) => void;
  onEnd: () => void;
}

interface Line {
  start: number;
  text: string; // what is spoken
  spokenOffset: number; // where `text` begins within the line (after trimming)
}

let session = 0;

export function canSpeak() {
  return isNative || "speechSynthesis" in window;
}

export function stopReading() {
  session++;
  if (isNative) NativeOcr.stopSpeaking().catch(() => {});
  else window.speechSynthesis?.cancel();
}

export async function readAloud(o: ReadOptions) {
  stopReading();
  const my = ++session;
  const lines: Line[] = [];
  let pos = 0;
  for (const raw of o.text.split("\n")) {
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t && pos + raw.length > o.from) {
      const cut = Math.max(0, o.from - pos - lead);
      const text = t.replace(/^\[Page (\d+)\]$/, "Page $1.").slice(cut);
      if (text) lines.push({ start: pos + lead + cut, text, spokenOffset: 0 });
    }
    pos += raw.length + 1;
  }

  for (const line of lines) {
    if (my !== session) return;
    await speakLine(line, o, my);
  }
  if (my === session) o.onEnd();
}

function speakLine(line: Line, o: ReadOptions, my: number): Promise<void> {
  // Report the first word straight away (some engines skip the first boundary).
  const first = line.text.match(/\S+/);
  if (first) o.onWord(line.start + first.index!, line.start + first.index! + first[0].length);

  if (isNative) {
    return new Promise((resolve) => {
      const id = `l${my}-${line.start}`;
      const subs = [
        NativeOcr.addListener("speechRange", (e) => {
          if (e.id === id && my === session) o.onWord(line.start + e.start, line.start + e.end);
        }),
        NativeOcr.addListener("speechDone", (e) => {
          if (e.id !== id) return;
          subs.forEach((p) => p.then((h) => h.remove()));
          resolve();
        }),
      ];
      NativeOcr.speak({ text: line.text, id, rate: o.rate }).catch(() => resolve());
    });
  }

  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(line.text);
    u.lang = "en-US";
    u.rate = o.rate;
    u.onboundary = (e) => {
      if (my !== session || e.name !== "word") return;
      const len = e.charLength || line.text.slice(e.charIndex).match(/^\S+/)?.[0].length || 1;
      o.onWord(line.start + e.charIndex, line.start + e.charIndex + len);
    };
    u.onend = () => resolve();
    u.onerror = () => resolve();
    try {
      window.speechSynthesis.speak(u);
    } catch {
      resolve(); // no voice available: finish instead of hanging on "Stop"
    }
  });
}
