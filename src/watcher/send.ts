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

/**
 * Send a text message through the active Baileys WhatsApp connection.
 *
 * This is the single outbound path called from the IPC "send" method handler.
 * It handles the complete send lifecycle including pre-flight validation,
 * recipient resolution, Markdown conversion, self-echo suppression, and
 * post-send contact tracking.
 *
 * Markdown formatting in `message` is automatically converted to WhatsApp's
 * native codes (`**bold**` becomes `*bold*`, etc.) before sending.
 *
 * The message-key ID returned by Baileys is registered in `sentMessageIds`
 * for 30 seconds so that the watcher's own `messages.upsert` echo is silently
 * discarded rather than delivered back to the MCP client.
 *
 * @param message    The message body.  Markdown formatting is supported and
 *                   converted automatically.
 * @param recipient  Optional target: a phone number ("+41764502698"), a
 *                   display-name substring ("Alice"), or an explicit JID
 *                   ("41764502698@s.whatsapp.net").  Defaults to the
 *                   authenticated account's own JID (self-chat / Saved
 *                   Messages).
 * @returns          A preview of the sent message (truncated to 80 chars if
 *                   longer), suitable for returning as the MCP tool result.
 * @throws           An error with a descriptive message if the socket is not
 *                   initialised, the connection is not open, or the self-JID
 *                   is not yet known.
 */
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
