/**
 * persistence.ts — Re-exports shared persistence from aibroker + WA-specific store caches.
 *
 * Shared: setAppDir, getAppDir, DEFAULT_VOICE_CONFIG, loadVoiceConfig, saveVoiceConfig,
 *         loadSessionRegistry, saveSessionRegistry
 * Local:  loadStoreCache, saveStoreCache (Baileys-specific, cannot move to aibroker)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Chat, Contact } from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";

import { getAppDir } from "aibroker";
import { chatStore, contactStore, messageStore } from "./state.js";
import { log } from "./log.js";

// ── Re-export shared persistence from aibroker ──

export {
  setAppDir,
  getAppDir,
  DEFAULT_VOICE_CONFIG,
  loadVoiceConfig,
  saveVoiceConfig,
  loadSessionRegistry,
  saveSessionRegistry,
} from "aibroker";

// ── WA-specific: Baileys store cache persistence ──

export function loadStoreCache(): void {
  const appDir = getAppDir();

  try {
    const chatPath = join(appDir, "chat-cache.json");
    if (existsSync(chatPath)) {
      const raw = JSON.parse(readFileSync(chatPath, "utf-8")) as Chat[];
      for (const chat of raw) {
        if (chat.id) chatStore.set(chat.id, chat);
      }
      process.stderr.write(
        `[whazaa-watch] Loaded ${chatStore.size} chats from cache\n`
      );
    }
  } catch {
    // Corrupted cache — ignore, will be overwritten on next sync
  }

  try {
    const contactPath = join(appDir, "contact-cache.json");
    if (existsSync(contactPath)) {
      const raw = JSON.parse(readFileSync(contactPath, "utf-8")) as Contact[];
      for (const contact of raw) {
        if (contact.id) contactStore.set(contact.id, contact);
      }
      process.stderr.write(
        `[whazaa-watch] Loaded ${contactStore.size} contacts from cache\n`
      );
    }
  } catch {
    // Corrupted cache — ignore
  }

  try {
    const msgPath = join(appDir, "message-cache.json");
    if (existsSync(msgPath)) {
      const raw = JSON.parse(readFileSync(msgPath, "utf-8")) as Record<string, proto.IWebMessageInfo[]>;
      let totalMsgs = 0;
      for (const [jid, msgs] of Object.entries(raw)) {
        if (Array.isArray(msgs) && msgs.length > 0) {
          messageStore.set(jid, msgs);
          totalMsgs += msgs.length;
        }
      }
      process.stderr.write(
        `[whazaa-watch] Loaded ${totalMsgs} messages across ${messageStore.size} JIDs from cache\n`
      );
    }
  } catch {
    // Corrupted cache — ignore, will be overwritten on next sync
  }
}

export function saveStoreCache(): void {
  try {
    const appDir = getAppDir();
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "chat-cache.json"), JSON.stringify(Array.from(chatStore.values())), "utf-8");
    writeFileSync(join(appDir, "contact-cache.json"), JSON.stringify(Array.from(contactStore.values())), "utf-8");

    // Serialize messageStore: only save essential fields to keep file small
    const msgObj: Record<string, Array<{ key: proto.IMessageKey; messageTimestamp: number | null; message: proto.IMessage | null | undefined }>> = {};
    for (const [jid, msgs] of messageStore) {
      msgObj[jid] = msgs.map((m) => ({
        key: m.key ?? {},
        messageTimestamp: m.messageTimestamp != null
          ? (typeof m.messageTimestamp === "number" ? m.messageTimestamp : Number(m.messageTimestamp))
          : null,
        message: m.message ?? null,
      }));
    }
    writeFileSync(join(appDir, "message-cache.json"), JSON.stringify(msgObj), "utf-8");
  } catch (err) {
    log(`Failed to save store cache: ${err}`);
  }
}
