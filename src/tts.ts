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
 *   WHAZAA_TTS_VOICE  Default voice name (default: "bm_fable")
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Resolve ffmpeg path at module load time so launchd environments (which lack
// /opt/homebrew/bin in PATH) can still find ffmpeg installed via Homebrew.
const FFMPEG =
  ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"].find(
    (p) => p === "ffmpeg" || existsSync(p)
  ) ?? "ffmpeg";

/** Known Kokoro voice names */
export type KokoroVoice =
  | "af_heart" | "af_alloy" | "af_aoede" | "af_bella" | "af_jessica"
  | "af_kore" | "af_nicole" | "af_nova" | "af_river" | "af_sarah" | "af_sky"
  | "am_adam" | "am_echo" | "am_eric" | "am_fenrir" | "am_liam"
  | "am_michael" | "am_onyx" | "am_puck" | "am_santa"
  | "bf_alice" | "bf_emma" | "bf_isabella" | "bf_lily"
  | "bm_daniel" | "bm_fable" | "bm_george" | "bm_lewis";

const KNOWN_VOICES: KokoroVoice[] = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica",
  "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

const DEFAULT_VOICE: KokoroVoice = (process.env.WHAZAA_TTS_VOICE as KokoroVoice | undefined) ?? "bm_fable";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Singleton KokoroTTS instance (lazy-initialized on first use)

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


/**
 * Convert text to a WhatsApp-compatible OGG Opus voice note buffer.
 *
 * @param text   The text to synthesize
 * @param voice  Kokoro voice name (default: WHAZAA_TTS_VOICE env or "bm_fable")
 * @returns      OGG Opus audio buffer ready to pass to Baileys sendMessage
 */
export async function textToVoiceNote(
  text: string,
  voice?: string
): Promise<Buffer> {
  if (!text || text.trim().length === 0) {
    throw new Error("TTS: text must not be empty");
  }

  // Ensure ffmpeg is available before doing expensive TTS work.
  // FFMPEG is resolved at module load time via static path lookup so that
  // launchd environments (which strip /opt/homebrew/bin from PATH) still work.
  if (FFMPEG === "ffmpeg" && !existsSync("/usr/bin/ffmpeg")) {
    // Only warn — the bare "ffmpeg" fallback may still work if PATH has it.
    process.stderr.write(
      "[whazaa-tts] Warning: ffmpeg not found at known Homebrew paths; " +
        "falling back to bare 'ffmpeg' (may fail in restricted environments).\n"
    );
  }

  // Resolve voice name
  const resolvedVoice: KokoroVoice = resolveVoice(voice ?? DEFAULT_VOICE);

  // Initialize TTS (lazy — blocks until ready on first call)
  await ensureInitialized();

  process.stderr.write(
    `[whazaa-tts] Generating audio: voice=${resolvedVoice}, text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"\n`
  );

  // Use generate() instead of stream() — stream() deadlocks on an ONNX
  // runtime mutex bug (libc++ "mutex lock failed: Invalid argument").
  // generate() handles long texts fine without truncation.
  const result = await ttsInstance!.generate(text, { voice: resolvedVoice });
  const combined: Float32Array = result.audio;
  const sampleRate: number = result.sampling_rate ?? 24_000;

  if (combined.length === 0) {
    throw new Error("TTS: generate produced no audio");
  }

  process.stderr.write(
    `[whazaa-tts] Generated ${combined.length} samples at ${sampleRate} Hz\n`
  );

  // Temp file paths
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wavPath = join(tmpdir(), `whazaa-tts-${uid}.wav`);
  const oggPath = join(tmpdir(), `whazaa-tts-${uid}.ogg`);

  try {
    // Encode Float32 PCM to WAV (44-byte header + Int16 samples)
    writeFileSync(wavPath, float32ToWav(combined, sampleRate));

    // Convert WAV → OGG Opus via ffmpeg
    // -y: overwrite output
    // -i: input file
    // -c:a libopus: use Opus codec
    // -b:a 64k: 64 kbps bitrate (WhatsApp compatible)
    // -ar 24000: 24 kHz sample rate
    // -ac 1: mono
    // -application voip: optimize for voice
    // -vbr off: constant bitrate for compatibility
    const ffmpegCmd = `"${FFMPEG}" -y -i "${wavPath}" -c:a libopus -b:a 64k -ar 24000 -ac 1 -application voip -vbr off "${oggPath}" 2>&1`;

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
 * Synthesize text and play it through the Mac's local speakers using afplay.
 * Non-blocking: the audio plays in the background while the watcher continues.
 * The temporary WAV file is deleted after playback completes.
 *
 * @param text   The text to synthesize
 * @param voice  Kokoro voice name (default: WHAZAA_TTS_VOICE env or "bm_fable")
 */
export async function speakLocally(text: string, voice?: string): Promise<void> {
  if (!text || text.trim().length === 0) {
    throw new Error("TTS: text must not be empty");
  }

  const resolvedVoice: KokoroVoice = resolveVoice(voice ?? DEFAULT_VOICE);

  await ensureInitialized();

  process.stderr.write(
    `[whazaa-tts] Speaking locally: voice=${resolvedVoice}, text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"\n`
  );

  const speakResult = await ttsInstance!.generate(text, { voice: resolvedVoice });
  const speakAudio: Float32Array = speakResult.audio;
  const speakSampleRate: number = speakResult.sampling_rate ?? 24_000;

  if (speakAudio.length === 0) {
    throw new Error("TTS: generate produced no audio");
  }

  const wavPath = join(tmpdir(), `whazaa-speak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  writeFileSync(wavPath, float32ToWav(speakAudio, speakSampleRate));

  // Play via afplay (macOS built-in). Detached + unref so the watcher is not
  // blocked waiting for playback to finish.
  const child = spawn("afplay", [wavPath], { stdio: "ignore", detached: true });
  child.on("close", () => {
    try { unlinkSync(wavPath); } catch { /* ignore cleanup errors */ }
  });
  child.unref();
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
 * Encode a Float32Array of PCM samples to a WAV file buffer.
 * Produces a standard 16-bit PCM WAV (RIFF/WAVE, mono, little-endian).
 */
function float32ToWav(samples: Float32Array, sampleRate: number): Buffer {
  const numSamples = samples.length;
  const byteRate = sampleRate * 2; // 16-bit mono = 2 bytes/sample
  const dataSize = numSamples * 2;
  const buf = Buffer.allocUnsafe(44 + dataSize);

  // RIFF header
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");

  // fmt chunk
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);         // chunk size
  buf.writeUInt16LE(1, 20);          // PCM format
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);          // block align (1 ch * 2 bytes)
  buf.writeUInt16LE(16, 34);         // bits per sample

  // data chunk
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  // Convert Float32 [-1, 1] to Int16
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  return buf;
}

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
