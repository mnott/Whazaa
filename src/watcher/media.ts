/**
 * media.ts — Re-exports shared media utilities from aibroker + WA-specific downloads.
 *
 * Shared: WHISPER_BIN, WHISPER_MODEL, mimetypeToExt
 * Local: downloadImageToTemp, downloadAudioAndTranscribe, downloadDocumentToDownloads
 *        (these use Baileys downloadMediaMessage and cannot move to aibroker)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir, homedir } from "node:os";
import { join, extname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

import { downloadMediaMessage, proto } from "@whiskeysockets/baileys";
import type makeWASocket from "@whiskeysockets/baileys";
import pino from "pino";

import { mimetypeToExt, mimetypeToDocExt, WHISPER_BIN, WHISPER_MODEL } from "aibroker";
import { log } from "./log.js";

const execFileAsync = promisify(execFile);

// ── Re-export shared utilities from aibroker ──

export { WHISPER_BIN, WHISPER_MODEL } from "aibroker";
export { mimetypeToExt } from "aibroker";

// ── WA-specific: Image download ──

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

// ── WA-specific: Document download ──

function deduplicateFileName(dir: string, name: string): string {
  let candidate = join(dir, name);
  if (!existsSync(candidate)) return candidate;

  const ext = extname(name);
  const base = basename(name, ext);
  let i = 1;
  do {
    candidate = join(dir, `${base} (${i})${ext}`);
    i++;
  } while (existsSync(candidate));
  return candidate;
}

export async function downloadDocumentToDownloads(
  msg: proto.IWebMessageInfo,
  sock: ReturnType<typeof makeWASocket>
): Promise<{ path: string; fileName: string; caption: string | null } | null> {
  try {
    const docMsg = msg.message?.documentMessage ?? null;
    const vidMsg = msg.message?.videoMessage ?? null;
    const mediaMsg = docMsg ?? vidMsg;
    if (!mediaMsg) return null;

    const mimetype = mediaMsg.mimetype ?? null;
    const originalName = docMsg?.fileName ?? null;
    const caption = docMsg?.caption ?? vidMsg?.caption ?? null;

    const fileName = originalName
      ? originalName
      : `whazaa-file-${Date.now()}.${mimetypeToDocExt(mimetype)}`;

    const downloadsDir = join(homedir(), "Downloads");
    const filePath = deduplicateFileName(downloadsDir, fileName);

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
    log(`Document saved to ${filePath}`);
    return { path: filePath, fileName: basename(filePath), caption };
  } catch (err) {
    log(`Document download failed: ${err}`);
    return null;
  }
}

// ── WA-specific: Audio download + Whisper transcription ──

export async function downloadAudioAndTranscribe(
  msg: proto.IWebMessageInfo,
  sock: ReturnType<typeof makeWASocket>,
  duration: number,
  isPtt: boolean
): Promise<string | null> {
  const audioBase = `whazaa-audio-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const audioFile = join(tmpdir(), `${audioBase}.ogg`);
  const label = isPtt ? "[Voice note]" : "[Audio]";

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
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
