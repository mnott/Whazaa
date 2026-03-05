/**
 * commands.ts — Thin adapter-local command handler.
 *
 * Only handles commands that require direct Baileys access (/restart, /login).
 * All other commands are forwarded to the AIBroker hub daemon via route_message.
 */

import { watcherSendMessage } from "./send.js";
import { log } from "./log.js";

/**
 * Create the local message handler for adapter-specific commands.
 *
 * Only /restart and /login are handled here. Everything else should have
 * been routed to the hub by index.ts — this handler is the fallback for
 * commands that need direct adapter access.
 */
export function createMessageHandler(
  _getActiveSessionId: () => string,
  _setActiveSessionId: (id: string) => void,
  _getConsecutiveFailures: () => number,
  _setConsecutiveFailures: (n: number) => void,
): (text: string, timestamp: number) => void | Promise<void> {

  return function handleMessage(text: string, _timestamp: number): void | Promise<void> {
    const trimmedText = text.trim();

    if (trimmedText === "/restart") {
      log("/restart: watcher restart requested via WhatsApp");
      watcherSendMessage("Restarting Whazaa watcher...").catch(() => {});
      setTimeout(() => {
        log("/restart: exiting — launchd will restart us");
        process.exit(0);
      }, 1500);
      return;
    }

    // /login is handled via the triggerLogin callback in index.ts,
    // not here. This is just a safety net.
    if (trimmedText === "/login") {
      watcherSendMessage("Use the login flow (QR code) — handled by the watcher.").catch(() => {});
      return;
    }

    // Everything else should have gone to the hub. If we get here,
    // something went wrong with routing.
    log(`commands.ts: unexpected message received locally: ${trimmedText.slice(0, 60)}`);
  };
}
