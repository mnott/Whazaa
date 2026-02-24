/**
 * typing.ts — WhatsApp "typing..." (composing) presence indicator management.
 *
 * WhatsApp presence updates expire server-side after approximately 10 seconds,
 * so showing a sustained typing indicator requires periodic refresh.  This
 * module encapsulates that refresh loop and exposes a simple start/stop API.
 *
 * Typical lifecycle:
 *  1. An MCP tool call triggers an AI response generation.
 *  2. The IPC handler calls `startTypingIndicator(jid)` to signal to the
 *     WhatsApp contact that a reply is being composed.
 *  3. `send.ts` calls `stopTypingIndicator()` immediately before sending the
 *     outbound message, clearing the indicator atomically.
 *
 * Only one JID can be active at a time.  Calling `startTypingIndicator` while
 * already running for a different JID automatically stops the previous one.
 */

import { watcherSock, watcherStatus } from "./state.js";

// ---------------------------------------------------------------------------
// Typing indicator state
// ---------------------------------------------------------------------------

/** Interval handle for the typing indicator refresh loop */
let typingInterval: ReturnType<typeof setInterval> | null = null;

/** JID to send typing presence to — updated when composing starts */
let typingTargetJid: string | null = null;

/**
 * Start showing the "typing..." indicator on WhatsApp for the given JID.
 * Sends a "composing" presence update immediately and refreshes every 6 seconds
 * because WhatsApp expires the composing state after ~10 seconds.
 *
 * Safe to call repeatedly — stops any existing indicator before starting a new one.
 */
export function startTypingIndicator(jid: string): void {
  stopTypingIndicator();
  if (!watcherSock || !watcherStatus.connected) return;

  typingTargetJid = jid;

  const sendComposing = (): void => {
    if (!watcherSock || !watcherStatus.connected || !typingTargetJid) return;
    watcherSock.sendPresenceUpdate("composing", typingTargetJid).catch((err: unknown) => {
      process.stderr.write(`[whazaa-watch] typing indicator error: ${err}\n`);
    });
  };

  sendComposing();
  typingInterval = setInterval(sendComposing, 6000);
}

/**
 * Stop the typing indicator. Clears the refresh interval and sends a
 * "paused" presence update so the indicator disappears immediately.
 */
export function stopTypingIndicator(): void {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
  }

  const jid = typingTargetJid;
  typingTargetJid = null;

  if (jid && watcherSock && watcherStatus.connected) {
    watcherSock.sendPresenceUpdate("paused", jid).catch((err: unknown) => {
      process.stderr.write(`[whazaa-watch] typing indicator stop error: ${err}\n`);
    });
  }
}
