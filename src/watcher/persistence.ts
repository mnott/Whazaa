/**
 * persistence.ts — Disk I/O for Whazaa's store caches and voice configuration.
 *
 * The watcher process maintains three in-memory Baileys stores (chats,
 * contacts, messages) that would normally be lost on restart.  This module
 * serialises those stores to JSON files under `~/.whazaa/` so that watcher
 * restarts can reload recent state without waiting for WhatsApp to re-push
 * its entire history.
 *
 * It also owns the read/write lifecycle for the voice-synthesis configuration
 * (`voice-config.json`), applying safe defaults for any missing fields.
 *
 * All I/O is synchronous (the callers are either at process startup or in
 * low-frequency event handlers) and any error is logged to stderr rather than
 * thrown, so a corrupted cache never prevents the watcher from starting.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Chat, Contact } from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";

import {
  chatStore,
  contactStore,
  messageStore,
  sessionRegistry,
  clientQueues,
} from "./state.js";
import { log } from "./log.js";
import type { RegisteredSession, VoiceConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

export const WHAZAA_DIR = join(homedir(), ".whazaa");
export const CHAT_CACHE_PATH = join(WHAZAA_DIR, "chat-cache.json");
export const CONTACT_CACHE_PATH = join(WHAZAA_DIR, "contact-cache.json");
export const MESSAGE_CACHE_PATH = join(WHAZAA_DIR, "message-cache.json");
export const VOICE_CONFIG_PATH = join(WHAZAA_DIR, "voice-config.json");
export const SESSION_REGISTRY_PATH = join(WHAZAA_DIR, "sessions.json");

// ---------------------------------------------------------------------------
// Voice config defaults and persistence
// ---------------------------------------------------------------------------

/**
 * Factory-default voice-synthesis settings used when no config file exists
 * or when the config file is missing individual fields.
 *
 * The `personas` map ships with four built-in Kokoro voices so new
 * installations have sensible defaults without any manual configuration.
 */
export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  defaultVoice: "bm_fable",
  voiceMode: false,
  localMode: false,
  personas: {
    "Nicole": "af_nicole",
    "George": "bm_george",
    "Daniel": "bm_daniel",
    "Fable": "bm_fable",
  },
};

/**
 * Load the voice-synthesis configuration from `~/.whazaa/voice-config.json`.
 *
 * Missing top-level fields are back-filled from {@link DEFAULT_VOICE_CONFIG}
 * and missing persona entries are merged with the default persona map, so
 * callers always receive a fully-populated object.
 *
 * Falls back to a deep copy of {@link DEFAULT_VOICE_CONFIG} if the file does
 * not exist or cannot be parsed.
 *
 * @returns  A complete {@link VoiceConfig} object, never null.
 */
export function loadVoiceConfig(): VoiceConfig {
  try {
    if (existsSync(VOICE_CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(VOICE_CONFIG_PATH, "utf-8")) as VoiceConfig;
      return { ...DEFAULT_VOICE_CONFIG, ...raw, personas: { ...DEFAULT_VOICE_CONFIG.personas, ...raw.personas } };
    }
  } catch {
    // Corrupted config — fall back to defaults
  }
  return { ...DEFAULT_VOICE_CONFIG, personas: { ...DEFAULT_VOICE_CONFIG.personas } };
}

/**
 * Persist the given voice-synthesis configuration to
 * `~/.whazaa/voice-config.json`, creating the directory if it does not exist.
 *
 * Errors are logged to stderr and silently swallowed so that a failure to
 * write the config (e.g. a read-only filesystem) does not crash the watcher.
 *
 * @param config  The fully-populated {@link VoiceConfig} object to save.
 */
export function saveVoiceConfig(config: VoiceConfig): void {
  try {
    mkdirSync(WHAZAA_DIR, { recursive: true });
    writeFileSync(VOICE_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch (err) {
    log(`Failed to save voice config: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Chat/contact/message store persistence
// ---------------------------------------------------------------------------

/**
 * Restore the Baileys stores from their on-disk cache files.
 *
 * Attempts to load all three cache files ({@link CHAT_CACHE_PATH},
 * {@link CONTACT_CACHE_PATH}, {@link MESSAGE_CACHE_PATH}) and populate the
 * corresponding in-memory maps in state.ts.  Each file is loaded
 * independently — a corrupted chat cache does not prevent contacts or
 * messages from loading.
 *
 * Should be called exactly once at startup, before the Baileys socket is
 * opened, so that the stores are pre-populated by the time the first
 * WhatsApp event arrives.
 *
 * All errors are caught and logged to stderr; the function never throws.
 */
export function loadStoreCache(): void {
  try {
    if (existsSync(CHAT_CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(CHAT_CACHE_PATH, "utf-8")) as Chat[];
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
    if (existsSync(CONTACT_CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(CONTACT_CACHE_PATH, "utf-8")) as Contact[];
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
    if (existsSync(MESSAGE_CACHE_PATH)) {
      const raw = JSON.parse(readFileSync(MESSAGE_CACHE_PATH, "utf-8")) as Record<string, proto.IWebMessageInfo[]>;
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

/**
 * Flush the current state of all three in-memory Baileys stores to disk.
 *
 * Writes {@link CHAT_CACHE_PATH}, {@link CONTACT_CACHE_PATH}, and
 * {@link MESSAGE_CACHE_PATH} in a single call.  The message cache is trimmed
 * to only the fields required for history-fetch anchor points (`key`,
 * `messageTimestamp`, `message`) to keep the file size manageable.
 *
 * Typically called after each `messaging-history.set` event so that watcher
 * restarts can recover recent state without waiting for WhatsApp to re-push
 * full history.
 *
 * The `~/.whazaa/` directory is created if it does not exist.  Any I/O error
 * is logged to stderr and silently swallowed.
 */
export function saveStoreCache(): void {
  try {
    mkdirSync(WHAZAA_DIR, { recursive: true });
    writeFileSync(CHAT_CACHE_PATH, JSON.stringify(Array.from(chatStore.values())), "utf-8");
    writeFileSync(CONTACT_CACHE_PATH, JSON.stringify(Array.from(contactStore.values())), "utf-8");

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
    writeFileSync(MESSAGE_CACHE_PATH, JSON.stringify(msgObj), "utf-8");
  } catch (err) {
    log(`Failed to save store cache: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Session registry persistence
// ---------------------------------------------------------------------------

/**
 * Persist the current session registry to `~/.whazaa/sessions.json`.
 *
 * Saves only the fields needed to restore sessions after a watcher restart:
 * sessionId, name, and itermSessionId. Call after any registry mutation
 * (register, rename, kill, discover).
 */
export function saveSessionRegistry(): void {
  try {
    mkdirSync(WHAZAA_DIR, { recursive: true });
    const entries = Array.from(sessionRegistry.values()).map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      itermSessionId: s.itermSessionId,
    }));
    writeFileSync(SESSION_REGISTRY_PATH, JSON.stringify(entries, null, 2), "utf-8");
  } catch (err) {
    log(`Failed to save session registry: ${err}`);
  }
}

/**
 * Restore persisted sessions into the registry from `~/.whazaa/sessions.json`.
 *
 * Called once at watcher startup before auto-discover runs. Sessions are loaded
 * with their original sessionId and name; liveness is verified later by the
 * auto-discover prune phase.
 */
export function loadSessionRegistry(): void {
  try {
    if (!existsSync(SESSION_REGISTRY_PATH)) return;
    const raw = JSON.parse(readFileSync(SESSION_REGISTRY_PATH, "utf-8")) as Array<{
      sessionId: string;
      name: string;
      itermSessionId?: string;
    }>;
    for (const entry of raw) {
      if (!entry.sessionId) continue;
      sessionRegistry.set(entry.sessionId, {
        sessionId: entry.sessionId,
        name: entry.name ?? "Unknown",
        itermSessionId: entry.itermSessionId,
        registeredAt: Date.now(),
      });
      if (!clientQueues.has(entry.sessionId)) {
        clientQueues.set(entry.sessionId, []);
      }
    }
    if (raw.length > 0) {
      log(`Restored ${raw.length} session(s) from disk`);
    }
  } catch {
    // Corrupted file — start fresh
  }
}
