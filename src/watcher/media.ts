/**
 * media.ts — Media download and audio transcription for incoming WhatsApp messages.
 *
 * Provides two independent helpers:
 *
 *  - {@link downloadImageToTemp}: Downloads an image (or sticker) payload from
 *    a Baileys message to a uniquely-named temp file.  The path is returned so
 *    the caller (typically the incoming-message handler) can embed it in the
 *    formatted message body for Claude Code to read via the file-read tool.
 *
 *  - {@link downloadAudioAndTranscribe}: Downloads a voice-note or audio-message
 *    payload to a temp `.ogg` file, runs it through OpenAI Whisper (invoked as
 *    a subprocess), and returns the transcript as a labelled string.
 *
 * Both functions accept the Baileys socket as a parameter rather than
 * importing it from state.ts, so this module has zero project-level imports
 * and sits at the very bottom of the dependency graph alongside types.ts.
 *
 * Temp files for images are intentionally left in `/tmp` for the OS to clean
 * up; audio files and all Whisper output artefacts are deleted in the
 * `finally` block of {@link downloadAudioAndTranscribe}.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

import { downloadMediaMessage, proto } from "@whiskeysockets/baileys";
import type makeWASocket from "@whiskeysockets/baileys";
import pino from "pino";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

/**
 * Map a WhatsApp image mimetype to a sensible file extension.
 */
export function mimetypeToExt(mimetype: string | null | undefined): string {
  if (!mimetype) return "jpg";
  if (mimetype.includes("png")) return "png";
  if (mimetype.includes("webp")) return "webp";
  if (mimetype.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Download a Baileys image (or video/document/sticker) message to a temp file.
 * Returns the absolute path to the saved file, or null on failure.
 *
 * The caller is responsible for deleting the file when done, but since these
 * files are meant to be read by Claude Code from the terminal, we leave them
 * in /tmp and let the OS clean them up eventually.
 */
export async function downloadImageToTemp(
  msg: proto.IWebMessageInfo,
  sock: ReturnType<typeof makeWASocket>
): Promise<string | null> {
  try {
    const imageMsg = msg.message?.imageMessage ?? msg.message?.stickerMessage ?? null;
    if (!imageMsg) return null;

    const ext = mimetypeToExt(imageMsg.mimetype);
    const filePath = join(tmpdir(), `whazaa-img-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);

    const buffer = await downloadMediaMessage(
      msg as Parameters<typeof downloadMediaMessage>[0],
      "buffer",
      {},
      {
        logger: pino({ level: "silent" }),
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    writeFileSync(filePath, buffer as Buffer);
    log(`Image saved to ${filePath}`);
    return filePath;
  } catch (err) {
    log(`Image download failed: ${err}`);
    return null;
  }
}

/**
 * Absolute path to the `whisper` CLI binary used for audio transcription.
 *
 * Resolved at module load time by probing known Homebrew installation paths
 * for both Apple Silicon (`/opt/homebrew/bin/whisper`) and Intel
 * (`/usr/local/bin/whisper`) Macs, falling back to a bare `"whisper"` string
 * that relies on the process `PATH` if neither Homebrew path exists.
 */
export const WHISPER_BIN =
  ["/opt/homebrew/bin/whisper", "/usr/local/bin/whisper", "whisper"].find(
    (p) => p === "whisper" || existsSync(p)
  ) ?? "whisper";

/**
 * The Whisper model name passed to `--model` when transcribing audio.
 *
 * Defaults to `"large-v3-turbo"` for a good balance of accuracy and speed.
 * Override by setting the `WHAZAA_WHISPER_MODEL` environment variable to any
 * model name recognised by your Whisper installation (e.g. `"base"`,
 * `"small"`, `"medium"`, `"large-v3"`).
 */
export const WHISPER_MODEL = process.env.WHAZAA_WHISPER_MODEL || "small";

/**
 * Download a Baileys audio message to a temp file and transcribe it with Whisper.
 * Returns a formatted string "[Voice note]: <transcript>" or "[Audio]: <transcript>".
 * Returns null on failure.
 *
 * @param msg       The Baileys message object
 * @param sock      The active Baileys socket (for reupload requests)
 * @param duration  Duration of the audio in seconds (from audioMessage.seconds)
 * @param isPtt     True if the message is a voice note (ptt), false for regular audio
 */
export async function downloadAudioAndTranscribe(
  msg: proto.IWebMessageInfo,
  sock: ReturnType<typeof makeWASocket>,
  duration: number,
  isPtt: boolean
): Promise<string | null> {
  const audioBase = `whazaa-audio-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const audioFile = join(tmpdir(), `${audioBase}.ogg`);
  const label = isPtt ? "[Voice note]" : "[Audio]";

  // Collect all Whisper output artifacts for cleanup in finally block
  const filesToClean: string[] = [
    audioFile,
    join(tmpdir(), `${audioBase}.txt`),
    join(tmpdir(), `${audioBase}.json`),
    join(tmpdir(), `${audioBase}.vtt`),
    join(tmpdir(), `${audioBase}.srt`),
    join(tmpdir(), `${audioBase}.tsv`),
  ];

  try {
    log(`Downloading audio (${duration}s, ptt=${isPtt})...`);

    const buffer = await downloadMediaMessage(
      msg as Parameters<typeof downloadMediaMessage>[0],
      "buffer",
      {},
      {
        logger: pino({ level: "silent" }),
        reuploadRequest: sock.updateMediaMessage,
      }
    );

    writeFileSync(audioFile, buffer as Buffer);
    log(`Audio saved to ${audioFile}, running Whisper (${WHISPER_BIN}, model=${WHISPER_MODEL})...`);

    // Run Whisper with a 120-second timeout.
    // Pass an expanded PATH so Whisper can find ffmpeg even when launched from
    // launchd (which only has /usr/bin:/bin:/usr/sbin:/sbin in its environment).
    await execFileAsync(
      WHISPER_BIN,
      [audioFile, "--model", WHISPER_MODEL, "--output_format", "txt", "--output_dir", tmpdir(), "--verbose", "False"],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      }
    );

    // Whisper writes <basename>.txt in the output_dir
    const txtPath = join(tmpdir(), `${audioBase}.txt`);
    if (!existsSync(txtPath)) {
      log(`Whisper did not produce output at ${txtPath}`);
      return null;
    }

    const transcript = readFileSync(txtPath, "utf-8").trim();
    log(`Transcription: ${transcript.slice(0, 80)}`);

    return `${label}: ${transcript}`;
  } catch (err) {
    log(`Audio transcription failed: ${err}`);
    return null;
  } finally {
    // Always clean up all Whisper output artifacts
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore — file may not exist */ }
    }
  }
}
