/**
 * state.ts — Re-exports shared state from aibroker + WhatsApp-specific state.
 *
 * Shared session routing, queues, and dispatch logic come from aibroker.
 * WhatsApp-specific state (Baileys socket, stores, connection status,
 * message source routing) is defined locally.
 */

import type { Chat, Contact } from "@whiskeysockets/baileys";
import { proto } from "@whiskeysockets/baileys";
import type makeWASocket from "@whiskeysockets/baileys";

import type { ContactEntry } from "./types.js";

// ── Re-export shared state from aibroker ──

export {
  sessionRegistry,
  managedSessions,
  sessionTtyCache,
  updateSessionTtyCache,
  activeClientId,
  setActiveClientId,
  activeItermSessionId,
  setActiveItermSessionId,
  cachedSessionList,
  cachedSessionListTime,
  setCachedSessionList,
  clientQueues,
  clientWaiters,
  contactMessageQueues,
  sentMessageIds,
  dispatchIncomingMessage,
  enqueueContactMessage,
  commandHandler,
  setCommandHandler,
} from "aibroker";

// ── WhatsApp-specific: Contact directory ──
// Uses Whazaa's ContactEntry (jid, phoneNumber) — NOT aibroker's generic one

export const contactDirectory = new Map<string, ContactEntry>();

// ── WhatsApp-specific: Baileys stores ──

export const chatStore = new Map<string, Chat>();
export const contactStore = new Map<string, Contact>();
export const messageStore = new Map<string, proto.IWebMessageInfo[]>();

// ── WhatsApp-specific: Baileys socket ──

export let watcherSock: ReturnType<typeof makeWASocket> | null = null;

export function setWatcherSock(sock: ReturnType<typeof makeWASocket> | null): void {
  watcherSock = sock;
}

// ── WhatsApp-specific: Connection status ──

export let watcherStatus = {
  connected: false,
  phoneNumber: null as string | null,
  selfJid: null as string | null,
  selfLid: null as string | null,
  awaitingQR: false,
};

export function setWatcherStatus(status: typeof watcherStatus): void {
  watcherStatus = status;
}

// ── WhatsApp-specific: Message source (prefix routing: [Whazaa] vs [PAILot]) ──

export type MessageSource = "whatsapp" | "pailot";
export let messageSource: MessageSource = "whatsapp";

export function setMessageSource(src: MessageSource): void {
  messageSource = src;
}
