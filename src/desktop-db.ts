/**
 * desktop-db.ts — Read WhatsApp Desktop macOS SQLite database
 *
 * The WhatsApp Desktop app stores all chat data in:
 *   ~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
 *
 * Key tables:
 *   ZWACHATSESSION — chat list (inbox)
 *   ZWAMESSAGE     — individual messages
 *
 * Timestamps: WhatsApp Desktop uses Apple Core Data timestamps (seconds since
 * 2001-01-01). Add APPLE_EPOCH_OFFSET to convert to Unix epoch (seconds since
 * 1970-01-01).
 *
 * This module is OPTIONAL: all functions return null/empty when the DB is not
 * present (non-macOS platforms, or Desktop app not installed).
 *
 * The DB is ALWAYS opened readonly — we never write to WhatsApp's DB.
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DESKTOP_DB_PATH = join(
  homedir(),
  "Library",
  "Group Containers",
  "group.net.whatsapp.WhatsApp.shared",
  "ChatStorage.sqlite"
);

/** Seconds between Unix epoch (1970-01-01) and Apple Core Data epoch (2001-01-01) */
const APPLE_EPOCH_OFFSET = 978307200;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the WhatsApp Desktop SQLite database exists on this system.
 * On non-macOS platforms this will always return false.
 */
export function isDesktopDbAvailable(): boolean {
  return existsSync(DESKTOP_DB_PATH);
}

export interface DesktopChat {
  jid: string;
  name: string;
  lastMessageText: string | null;
  lastMessageDate: string; // ISO 8601
  unreadCount: number;
  archived: boolean;
}

/**
 * List chats from the WhatsApp Desktop SQLite database, sorted by last
 * message time descending (most recent first).
 *
 * Returns null if the database is not available.
 * Returns an empty array if the DB is available but has no matching chats.
 *
 * @param search  Optional case-insensitive filter on partner name or JID.
 * @param limit   Maximum number of chats to return (default 50).
 */
export function listChats(search?: string, limit?: number): DesktopChat[] | null {
  if (!isDesktopDbAvailable()) return null;

  const db = new Database(DESKTOP_DB_PATH, { readonly: true });
  try {
    let query = `
      SELECT
        ZCONTACTJID   AS jid,
        ZPARTNERNAME  AS name,
        ZLASTMESSAGETEXT AS lastText,
        ZLASTMESSAGEDATE AS lastDate,
        ZUNREADCOUNT  AS unread,
        ZARCHIVED     AS archived
      FROM ZWACHATSESSION
      WHERE ZREMOVED = 0 AND ZHIDDEN = 0
    `;

    const params: unknown[] = [];

    if (search) {
      query += ` AND (LOWER(ZPARTNERNAME) LIKE LOWER(?) OR ZCONTACTJID LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY ZLASTMESSAGEDATE DESC LIMIT ?`;
    params.push(limit ?? 50);

    const rows = db.prepare(query).all(...params) as Array<{
      jid: string | null;
      name: string | null;
      lastText: string | null;
      lastDate: number | null;
      unread: number | null;
      archived: number | null;
    }>;

    return rows.map((r) => ({
      jid: r.jid ?? "",
      name: r.name ?? r.jid ?? "",
      lastMessageText: r.lastText ?? null,
      lastMessageDate: r.lastDate != null
        ? new Date((r.lastDate + APPLE_EPOCH_OFFSET) * 1000).toISOString()
        : "",
      unreadCount: r.unread ?? 0,
      archived: r.archived === 1,
    }));
  } finally {
    db.close();
  }
}

export interface DesktopMessage {
  id: string;
  fromMe: boolean;
  timestamp: number;  // Unix seconds
  date: string;       // ISO 8601
  text: string;
  fromJid: string | null;
  toJid: string | null;
  pushName: string | null;
  type: string;
}

/**
 * Fetch messages for a specific chat JID from the WhatsApp Desktop SQLite DB.
 *
 * Returns null if the database is not available.
 * Returns an empty array if the chat is not found in the DB.
 *
 * Messages are returned in chronological order (oldest first).
 *
 * @param jid    Full WhatsApp JID (e.g. "41796074745@s.whatsapp.net").
 *               Also accepts phone numbers like "+41796074745" — normalised
 *               internally.
 * @param limit  Maximum number of messages to return (default 50).
 */
export function getMessages(jid: string, limit?: number): DesktopMessage[] | null {
  if (!isDesktopDbAvailable()) return null;

  const db = new Database(DESKTOP_DB_PATH, { readonly: true });
  try {
    // Normalise the JID — strip leading + and append @s.whatsapp.net if bare
    const normalised = normaliseJid(jid);

    // Find the chat session primary key for this JID
    const session = db.prepare(
      "SELECT Z_PK FROM ZWACHATSESSION WHERE ZCONTACTJID = ?"
    ).get(normalised) as { Z_PK: number } | undefined;

    if (!session) return [];

    const rows = db.prepare(`
      SELECT
        ZSTANZAID     AS id,
        ZISFROMME     AS fromMe,
        ZMESSAGEDATE  AS msgDate,
        ZTEXT         AS text,
        ZFROMJID      AS fromJid,
        ZTOJID        AS toJid,
        ZPUSHNAME     AS pushName,
        ZMESSAGETYPE  AS msgType
      FROM ZWAMESSAGE
      WHERE ZCHATSESSION = ?
      ORDER BY ZMESSAGEDATE DESC
      LIMIT ?
    `).all(session.Z_PK, limit ?? 50) as Array<{
      id: string | null;
      fromMe: number | null;
      msgDate: number | null;
      text: string | null;
      fromJid: string | null;
      toJid: string | null;
      pushName: string | null;
      msgType: number | null;
    }>;

    return rows
      .map((r): DesktopMessage => {
        const ts = r.msgDate != null ? r.msgDate + APPLE_EPOCH_OFFSET : 0;
        return {
          id: r.id ?? "",
          fromMe: r.fromMe === 1,
          timestamp: ts,
          date: ts > 0 ? new Date(ts * 1000).toISOString() : "",
          text: r.text ?? "[non-text message]",
          fromJid: r.fromJid ?? null,
          toJid: r.toJid ?? null,
          pushName: r.pushName ?? null,
          type: r.msgType === 0 ? "text" : (r.text ? "text" : "other"),
        };
      })
      .reverse(); // Chronological order (oldest first)
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a phone number or WhatsApp JID to the full JID form used by the
 * Desktop DB (e.g. "41796074745@s.whatsapp.net").
 *
 * Handles:
 *   "+41796074745"                  -> "41796074745@s.whatsapp.net"
 *   "41796074745"                   -> "41796074745@s.whatsapp.net"
 *   "41796074745@s.whatsapp.net"    -> unchanged (pass-through)
 *   "123456789@g.us"               -> unchanged (group JID, pass-through)
 */
function normaliseJid(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return `${digits}@s.whatsapp.net`;
}
