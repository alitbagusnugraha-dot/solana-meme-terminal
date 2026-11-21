/**
 * src/lib/sound.ts — Notifikasi suara via Web Audio (tanpa file audio).
 *
 * Browser memblokir audio sampai ada interaksi user. Panggil unlockAudio() dari
 * event klik/ketik pertama (page.tsx memasangnya otomatis). Setelah itu alert
 * tetap berbunyi walau tab sedang tidak aktif.
 */

export type AlertKind = "success" | "take-profit" | "stop-loss" | "trailing" | "trigger" | "error";

interface Tone {
  frequency: number;
  durationMs: number;
  gapMs?: number;
  type?: OscillatorType;
}

const PATTERNS: Record<AlertKind, Tone[]> = {
  success: [
    { frequency: 880, durationMs: 90 },
    { frequency: 1320, durationMs: 120 },
  ],
  "take-profit": [
    { frequency: 784, durationMs: 110 },
    { frequency: 988, durationMs: 110 },
    { frequency: 1319, durationMs: 220 },
  ],
  trailing: [
    { frequency: 988, durationMs: 120 },
    { frequency: 784, durationMs: 120 },
    { frequency: 988, durationMs: 200 },
  ],
  "stop-loss": [
    { frequency: 440, durationMs: 220, type: "sawtooth" },
    { frequency: 330, durationMs: 320, type: "sawtooth" },
  ],
  trigger: [{ frequency: 1500, durationMs: 70, gapMs: 40 }, { frequency: 1500, durationMs: 70 }],
  error: [
    { frequency: 220, durationMs: 180, type: "square" },
    { frequency: 196, durationMs: 260, type: "square" },
  ],
};

let context: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(value: boolean): void {
  enabled = value;
}

export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  if (!context) {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      context = new Ctor();
    } catch {
      context = null;
      return;
    }
  }
  if (context.state === "suspended") {
    void context.resume().catch(() => undefined);
  }
}

export function playAlert(kind: AlertKind): void {
  if (!enabled || !context) return;
  if (context.state === "suspended") void context.resume().catch(() => undefined);

  const pattern = PATTERNS[kind];
  let cursor = context.currentTime + 0.01;
  for (const tone of pattern) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = tone.type ?? "sine";
    oscillator.frequency.setValueAtTime(tone.frequency, cursor);

    const duration = tone.durationMs / 1000;
    gain.gain.setValueAtTime(0.0001, cursor);
    gain.gain.exponentialRampToValueAtTime(0.18, cursor + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, cursor + duration);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(cursor);
    oscillator.stop(cursor + duration + 0.02);
    cursor += duration + (tone.gapMs ?? 30) / 1000;
  }
}
