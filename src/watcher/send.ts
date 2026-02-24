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

  // Stop the typing indicator before sending — Claude is done thinking.
  stopTypingIndicator();

  const text = markdownToWhatsApp(message);
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
