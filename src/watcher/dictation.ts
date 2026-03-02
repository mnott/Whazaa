/**
 * dictation.ts — Local mic recording and Whisper transcription for desk dictation.
 *
 * Provides two helpers:
 *
 *  - {@link recordFromMic}: Records audio from the default Mac mic using `sox`,
 *    stopping automatically after ~2 seconds of silence. Returns the path to
 *    the recorded WAV file.
 *
 *  - {@link transcribeLocalAudio}: Transcribes a local audio file using the
 *    same Whisper binary and model already configured for WhatsApp voice notes.
 *
 * Both functions are used by the `dictate` IPC handler in ipc-server.ts.
 * Temp files are cleaned up by the caller or in `finally` blocks.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import { WHISPER_BIN, WHISPER_MODEL } from "./media.js";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

/**
 * Absolute path to the `sox` binary used for mic recording.
 *
 * Probes known Homebrew paths for Apple Silicon and Intel Macs,
 * falling back to a bare `"sox"` that relies on PATH.
 */
const SOX_BIN =
  ["/opt/homebrew/bin/sox", "/usr/local/bin/sox", "sox"].find(
    (p) => p === "sox" || existsSync(p)
  ) ?? "sox";

/**
 * Record audio from the default Mac microphone using sox.
 *
 * Starts recording at 16 kHz mono (Whisper's native rate) and stops
 * automatically when ~2 seconds of silence is detected. A short system
 * sound plays at start and stop to give audible feedback.
 *
 * @param maxDurationSec - Maximum recording duration before force-kill (default 60s).
 * @returns Absolute path to the recorded WAV file.
 */
export async function recordFromMic(maxDurationSec = 60): Promise<string> {
  const wavPath = join(tmpdir(), `whazaa-dictation-${Date.now()}.wav`);

  // Audible start indicator
  execFile("afplay", ["/System/Library/Sounds/Tink.aiff"], () => {});

  log(`Dictation: recording to ${wavPath} (max ${maxDurationSec}s)...`);

  try {
    await execFileAsync(
      SOX_BIN,
      [
        "-d",              // default audio input (mic)
        "-r", "16000",     // 16 kHz sample rate (Whisper native)
        "-c", "1",         // mono
        "-b", "16",        // 16-bit
        wavPath,
        "silence",
        "1", "0.2", "1%", // start: require 0.2s above 1% to begin
        "1", "2.0", "1%", // stop: end after 2s below 1%
      ],
      {
        timeout: maxDurationSec * 1000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      }
    );
  } catch (err: unknown) {
    // sox exits with non-zero when killed by timeout — that's OK if file exists
    if (!existsSync(wavPath)) {
      throw new Error(`Recording failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log(`Dictation: sox exited (likely timeout/silence stop) — file exists, continuing.`);
  }

  // Audible stop indicator
  execFile("afplay", ["/System/Library/Sounds/Pop.aiff"], () => {});

  log(`Dictation: recorded ${wavPath}`);
  return wavPath;
}

/**
 * Transcribe a local audio file using the Whisper CLI.
 *
 * Reuses the same WHISPER_BIN and WHISPER_MODEL configured for WhatsApp
 * voice note transcription in media.ts. All Whisper output artefacts are
 * cleaned up in the `finally` block.
 *
 * @param audioPath - Absolute path to the audio file (WAV, OGG, MP3, etc.).
 * @returns The raw transcript text.
 */
export async function transcribeLocalAudio(audioPath: string): Promise<string> {
  const base = audioPath.replace(/\.[^.]+$/, "");
  const baseName = base.split("/").pop()!;
  const outDir = tmpdir();

  // Collect all Whisper output artefacts for cleanup
  const filesToClean: string[] = [
    join(outDir, `${baseName}.txt`),
    join(outDir, `${baseName}.json`),
    join(outDir, `${baseName}.vtt`),
    join(outDir, `${baseName}.srt`),
    join(outDir, `${baseName}.tsv`),
  ];

  try {
    log(`Dictation: transcribing ${audioPath} (model=${WHISPER_MODEL})...`);

    await execFileAsync(
      WHISPER_BIN,
      [audioPath, "--model", WHISPER_MODEL, "--output_format", "txt", "--output_dir", outDir, "--verbose", "False"],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      }
    );

    const txtPath = join(outDir, `${baseName}.txt`);
    if (!existsSync(txtPath)) {
      throw new Error(`Whisper did not produce output at ${txtPath}`);
    }

    const transcript = readFileSync(txtPath, "utf-8").trim();
    log(`Dictation: transcript (${transcript.length} chars): ${transcript.slice(0, 80)}`);
    return transcript;
  } finally {
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore — file may not exist */ }
    }
  }
}
