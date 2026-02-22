/**
 * tts.ts — Text-to-speech module for Whazaa
 *
 * Converts text to an OGG Opus audio buffer suitable for sending as a
 * WhatsApp voice note (ptt: true) via Baileys.
 *
 * Pipeline:
 *   1. Kokoro-js generates Float32 PCM audio at 24 kHz
 *   2. PCM is written to a temp WAV file
 *   3. ffmpeg converts WAV → OGG Opus (libopus, 24 kHz, 1 ch)
 *   4. OGG buffer is returned and temp files are cleaned up
 *
 * The KokoroTTS instance is lazy-initialized on first use (~160 MB model
 * download on first call, then cached). Subsequent calls are fast.
 *
 * Environment variables:
 *   WHAZAA_TTS_VOICE  Default voice name (default: "af_heart")
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Known Kokoro voice names */
export type KokoroVoice =
  | "af_heart" | "af_alloy" | "af_aoede" | "af_bella" | "af_jessica"
  | "af_kore" | "af_nicole" | "af_nova" | "af_river" | "af_sarah" | "af_sky"
  | "am_adam" | "am_echo" | "am_eric" | "am_fenrir" | "am_liam"
  | "am_michael" | "am_onyx" | "am_puck" | "am_santa"
  | "bf_alice" | "bf_emma" | "bf_isabella" | "bf_lily"
  | "bm_daniel" | "bm_fable" | "bm_george" | "bm_lewis";

/** Available voice names — updated from README */
const KNOWN_VOICES: KokoroVoice[] = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica",
  "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

const DEFAULT_VOICE: KokoroVoice = (process.env.WHAZAA_TTS_VOICE as KokoroVoice | undefined) ?? "af_heart";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// ---------------------------------------------------------------------------
// Singleton KokoroTTS instance (lazy)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ttsInstance: any | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Lazy-initialize the KokoroTTS singleton.
 * Safe to call multiple times concurrently — only one init runs.
 */
async function ensureInitialized(): Promise<void> {
  if (ttsInstance !== null) return;

  if (initPromise !== null) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    process.stderr.write(
      `[whazaa-tts] Initializing Kokoro TTS (model: ${MODEL_ID}, dtype: q8)...\n`
    );

    // Dynamic import to avoid loading the heavy model at startup
    const { KokoroTTS } = await import("kokoro-js");

    ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: "q8",
      device: "cpu",
    });

    process.stderr.write("[whazaa-tts] Kokoro TTS ready.\n");
  })();

  await initPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert text to a WhatsApp-compatible OGG Opus voice note buffer.
 *
 * @param text   The text to synthesize
 * @param voice  Kokoro voice name (default: WHAZAA_TTS_VOICE env or "af_heart")
 * @returns      OGG Opus audio buffer ready to pass to Baileys sendMessage
 */
export async function textToVoiceNote(
  text: string,
  voice?: string
): Promise<Buffer> {
  if (!text || text.trim().length === 0) {
    throw new Error("TTS: text must not be empty");
  }

  // Ensure ffmpeg is available before doing expensive TTS work
  let ffmpegPath: string;
  try {
    ffmpegPath = execSync("which ffmpeg", { timeout: 5_000 }).toString().trim();
    if (!ffmpegPath) throw new Error("empty path");
  } catch {
    throw new Error("ffmpeg not found. Install it with: brew install ffmpeg");
  }

  // Resolve voice name
  const resolvedVoice: KokoroVoice = resolveVoice(voice ?? DEFAULT_VOICE);

  // Initialize TTS (lazy — blocks until ready on first call)
  await ensureInitialized();

  process.stderr.write(
    `[whazaa-tts] Generating audio: voice=${resolvedVoice}, text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"\n`
  );

  // Generate audio
  const audio = await ttsInstance!.generate(text, { voice: resolvedVoice });

  // Kokoro returns a RawAudio object with .audio (Float32Array),
  // .sampling_rate (number), and .toWav() (returns ArrayBuffer)
  const sampleRate: number = (audio.sampling_rate as number) ?? 24_000;
  const numSamples: number = (audio.audio as Float32Array).length;

  process.stderr.write(
    `[whazaa-tts] Generated ${numSamples} samples at ${sampleRate} Hz\n`
  );

  // Temp file paths
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wavPath = join(tmpdir(), `whazaa-tts-${uid}.wav`);
  const oggPath = join(tmpdir(), `whazaa-tts-${uid}.ogg`);

  try {
    // Write WAV using the built-in toWav() method
    const wavArrayBuffer: ArrayBuffer = audio.toWav() as ArrayBuffer;
    writeFileSync(wavPath, Buffer.from(wavArrayBuffer));

    // Convert WAV → OGG Opus via ffmpeg
    // -y: overwrite output
    // -i: input file
    // -c:a libopus: use Opus codec
    // -b:a 64k: 64 kbps bitrate (WhatsApp compatible)
    // -ar 24000: 24 kHz sample rate
    // -ac 1: mono
    // -application voip: optimize for voice
    // -vbr off: constant bitrate for compatibility
    const ffmpegCmd = `"${ffmpegPath}" -y -i "${wavPath}" -c:a libopus -b:a 64k -ar 24000 -ac 1 -application voip -vbr off "${oggPath}" 2>&1`;

    try {
      execSync(ffmpegCmd, { timeout: 30_000, stdio: "pipe" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`ffmpeg conversion failed: ${msg}`);
    }

    if (!existsSync(oggPath)) {
      throw new Error("ffmpeg did not produce output file");
    }

    const oggBuffer = readFileSync(oggPath);

    process.stderr.write(
      `[whazaa-tts] Converted to OGG Opus: ${oggBuffer.length} bytes\n`
    );

    return oggBuffer;
  } finally {
    // Clean up temp files
    for (const p of [wavPath, oggPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Return all available voice names.
 */
export function listVoices(): string[] {
  return [...KNOWN_VOICES];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied voice string to a known KokoroVoice.
 * Falls back to the default voice if the name is unrecognized.
 */
function resolveVoice(voice: string): KokoroVoice {
  const lower = voice.toLowerCase().trim();

  // "true" or "default" -> use the default voice
  if (lower === "true" || lower === "default" || lower === "") {
    return DEFAULT_VOICE;
  }

  // Check if it matches a known voice
  if (KNOWN_VOICES.includes(lower as KokoroVoice)) {
    return lower as KokoroVoice;
  }

  // Partial match (e.g. "george" -> "bm_george")
  const match = KNOWN_VOICES.find((v) => v.endsWith(`_${lower}`) || v === lower);
  if (match) return match;

  process.stderr.write(
    `[whazaa-tts] Unknown voice "${voice}", falling back to "${DEFAULT_VOICE}". Known voices: ${KNOWN_VOICES.join(", ")}\n`
  );
  return DEFAULT_VOICE;
}
