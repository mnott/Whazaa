/**
 * send.ts — Outbound WhatsApp message sending via the Baileys socket.
 *
 * This module exposes the single entry-point used by the IPC "send" handler
 * to deliver a text message through the active Baileys connection.  It
 * orchestrates the full pre-send sequence:
 *
 *  1. Guard against an uninitialised or disconnected socket.
 *  2. Resolve the recipient string to a normalized JID (phone number, name,
 *     or explicit JID all accepted).
 *  3. Clear the WhatsApp "typing..." indicator so it disappears when the
 *     message lands.
 *  4. Convert Markdown formatting to WhatsApp codes.
 *  5. Send via Baileys and register the resulting message ID in the
 *     self-echo suppression set.
 *  6. Record the recipient in the contact directory for future name lookups.
 *
 * Dependencies: state.ts, contacts.ts, typing.ts.
 */

import { watcherSock, watcherStatus, sentMessageIds } from "./state.js";
import { resolveRecipient, markdownToWhatsApp, trackContact } from "./contacts.js";
import { stopTypingIndicator } from "./typing.js";
import { broadcastText, broadcastVoice } from "./ws-gateway.js";
import { textToVoiceNote } from "../tts.js";
import { splitIntoChunks } from "aibroker";
import { loadVoiceConfig } from "./persistence.js";
import { log } from "./log.js";

export async function watcherSendMessage(message: string, recipient?: string): Promise<string> {
  if (!watcherSock) {
    throw new Error("WhatsApp socket not initialized. Is the watcher connected?");
  }
  if (!watcherStatus.connected) {
    throw new Error("WhatsApp is not connected. Check status with whatsapp_status.");
  }
  if (!watcherStatus.selfJid) {
    throw new Error("Self JID not yet known. Wait for connection to fully open.");
  }

  const targetJid = recipient ? resolveRecipient(recipient) : watcherStatus.selfJid;

  // Broadcast to connected PAILot clients (self-chat only)
  if (targetJid === watcherStatus.selfJid) {
    broadcastText(message);
  }

  // Stop the typing indicator before sending — Claude is done thinking.
  stopTypingIndicator();

  // Prepend U+FEFF (zero-width no-break space) as an invisible marker so
  // external apps (e.g. a mobile companion) can distinguish PAI-sent messages
  // from user-typed ones in the self-chat. The marker is invisible in WhatsApp
  // but detectable at position 0 programmatically.
  const text = "\uFEFF" + markdownToWhatsApp(message);
  const result = await watcherSock.sendMessage(targetJid, { text });

  if (result?.key?.id) {
    const id = result.key.id;
    sentMessageIds.add(id);
    setTimeout(() => sentMessageIds.delete(id), 30_000);
  }

  // Track outbound contact (non-self only)
  if (targetJid !== watcherStatus.selfJid) {
    trackContact(targetJid, null, Date.now());
  }

  const preview = message.length > 80 ? `${message.slice(0, 80)}...` : message;
  return preview;
}

/** Send a pre-rendered voice buffer to self-chat or a recipient. */
export async function watcherSendVoiceBuffer(
  buffer: Buffer,
  transcript?: string,
  recipient?: string,
): Promise<void> {
  if (!watcherSock) throw new Error("WhatsApp socket not initialized.");
  if (!watcherStatus.connected) throw new Error("WhatsApp is not connected.");
  if (!watcherStatus.selfJid) throw new Error("Self JID not yet known.");

  const targetJid = recipient ? resolveRecipient(recipient) : watcherStatus.selfJid;

  if (targetJid === watcherStatus.selfJid) {
    broadcastVoice(buffer, transcript ?? "");
  }

  const result = await watcherSock.sendMessage(targetJid, {
    audio: buffer,
    mimetype: "audio/ogg; codecs=opus",
    ptt: true,
  });

  if (result?.key?.id) {
    sentMessageIds.add(result.key.id);
    setTimeout(() => sentMessageIds.delete(result.key.id!), 30_000);
  }
}

/** Send a voice note (TTS) to self-chat or a recipient. Auto-chunks long text. */
export async function watcherSendVoice(text: string, recipient?: string): Promise<void> {
  if (!watcherSock) throw new Error("WhatsApp socket not initialized.");
  if (!watcherStatus.connected) throw new Error("WhatsApp is not connected.");
  if (!watcherStatus.selfJid) throw new Error("Self JID not yet known.");

  const targetJid = recipient ? resolveRecipient(recipient) : watcherStatus.selfJid;
  const voice = loadVoiceConfig().defaultVoice;
  const chunks = splitIntoChunks(text);

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));

    const audioBuffer = await textToVoiceNote(chunks[i], voice);

    if (targetJid === watcherStatus.selfJid) {
      broadcastVoice(audioBuffer, chunks[i]);
    }

    const result = await watcherSock.sendMessage(targetJid, {
      audio: audioBuffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: true,
    });

    if (result?.key?.id) {
      sentMessageIds.add(result.key.id);
      setTimeout(() => sentMessageIds.delete(result.key.id!), 30_000);
    }
  }

  log(`Voice sent (${chunks.length} chunk${chunks.length > 1 ? "s" : ""}) to ${targetJid}`);
}
