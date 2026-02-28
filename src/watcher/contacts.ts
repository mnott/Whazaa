/**
 * contacts.ts — JID resolution, contact tracking, and Markdown conversion.
 *
 * This module provides the utilities needed to translate human-readable
 * addresses (phone numbers, display names) into normalized WhatsApp JIDs, to
 * maintain a lightweight directory of recently active contacts, and to convert
 * Markdown-formatted text to WhatsApp's proprietary formatting syntax before
 * sending.
 *
 * It also houses the MIME-type lookup table used when sending files, keeping
 * all "what does this string mean in WhatsApp terms" logic in one place.
 *
 * Dependencies: only `state.ts` and `types.ts` from this package, making it
 * safe to import from any other watcher module without circular risk.
 */

import { contactDirectory } from "./state.js";
import type { ContactEntry } from "./types.js";

// ---------------------------------------------------------------------------
// MIME type map for file sending
// ---------------------------------------------------------------------------

/**
 * Map from lowercase file extension (including the leading dot) to the
 * corresponding MIME type string.
 *
 * Used by the file-sending handler to populate the `mimetype` field of
 * Baileys document/image/video/audio messages.  Covers the most common
 * office, image, video, and audio formats.  Unknown extensions should fall
 * back to `"application/octet-stream"`.
 */
export const MIME_MAP: Record<string, string> = {
  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".json": "application/json",
  // Images
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  // Video
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

// ---------------------------------------------------------------------------
// JID resolution
// ---------------------------------------------------------------------------

/**
 * Convert a human-readable phone number or JID to a normalized WhatsApp JID.
 *
 * Handles:
 *   "+41764502698"         -> "41764502698@s.whatsapp.net"
 *   "41764502698"          -> "41764502698@s.whatsapp.net"
 *   "41764502698@s.whatsapp.net" -> "41764502698@s.whatsapp.net" (pass-through)
 *   "123456789@g.us"       -> "123456789@g.us" (group, pass-through)
 */
export function resolveJid(recipient: string): string {
  const trimmed = recipient.trim();

  // Already a full JID
  if (trimmed.includes("@")) {
    return trimmed;
  }

  // Strip leading + and any spaces/dashes from phone numbers
  const digits = trimmed.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  return `${digits}@s.whatsapp.net`;
}

/**
 * Perform a case-insensitive substring search of `contactDirectory` to find a
 * JID matching the given display-name fragment.
 *
 * Returns the JID of the first matching entry, or null if no match is found.
 * When multiple contacts share a partial name the first-iterated entry wins;
 * callers should use a more specific name fragment to disambiguate.
 *
 * @param name  A display-name substring to search for (case-insensitive).
 * @returns     The normalized JID of the matching contact, or null.
 */
export function resolveNameToJid(name: string): string | null {
  const lowerName = name.toLowerCase();
  for (const entry of contactDirectory.values()) {
    if (entry.name && entry.name.toLowerCase().includes(lowerName)) {
      return entry.jid;
    }
  }
  return null;
}

/**
 * Resolve a free-form recipient string to a normalized WhatsApp JID.
 *
 * Resolution order:
 *  1. If the string contains "@" or matches a phone-number pattern
 *     (`+` or digit followed by digits/spaces/dashes), delegate directly to
 *     {@link resolveJid}.
 *  2. Otherwise attempt a name lookup via {@link resolveNameToJid}.
 *  3. If the name lookup fails, fall through to {@link resolveJid} treating
 *     the string as a bare phone number.
 *
 * @param recipient  Phone number, display name, or existing JID.
 * @returns          Normalized WhatsApp JID string.
 */
export function resolveRecipient(recipient: string): string {
  const trimmed = recipient.trim();

  // Looks like a phone number (starts with +, or is all digits/spaces/dashes)
  // or is already a JID
  if (trimmed.includes("@") || /^[\+\d][\d\s\-().]+$/.test(trimmed)) {
    return resolveJid(trimmed);
  }

  // Try name lookup
  const nameJid = resolveNameToJid(trimmed);
  if (nameJid) {
    return nameJid;
  }

  // Fall back to treating it as a phone number
  return resolveJid(trimmed);
}

/**
 * Upsert a contact entry in the in-memory `contactDirectory`.
 *
 * The entry is created fresh if the JID has not been seen before.  If an
 * existing entry is present:
 *  - The `lastSeen` timestamp and `name` are updated only when the new
 *    timestamp is strictly newer than the stored one.
 *  - If the new timestamp is not newer but a name is provided and the stored
 *    entry has no name, the name is back-filled without changing `lastSeen`.
 *
 * @param jid        Normalized JID of the contact.
 * @param name       Display name, or null if not known at call time.
 * @param timestamp  Unix epoch milliseconds of the triggering message.
 */
export function trackContact(jid: string, name: string | null, timestamp: number): void {
  const existing = contactDirectory.get(jid);
  if (!existing || timestamp > existing.lastSeen) {
    const phoneNumber = jid.split("@")[0];
    contactDirectory.set(jid, {
      jid,
      name: name ?? existing?.name ?? null,
      phoneNumber,
      lastSeen: timestamp,
    });
  } else if (name && !existing.name) {
    // Update name if we now have one
    existing.name = name;
  }
}

/**
 * Convert a subset of Markdown formatting syntax to WhatsApp's native codes.
 *
 * WhatsApp uses a different set of delimiters from standard Markdown:
 *
 * | Markdown              | WhatsApp          |
 * |-----------------------|-------------------|
 * | `**bold**`            | `*bold*`          |
 * | `*italic*`            | `_italic_`        |
 * | `` `code` ``          | ` ```code``` `    |
 * | `# Heading`           | `*HEADING*`       |
 * | `> blockquote`        | `▎ text`          |
 * | `---`                 | `———`             |
 * | `- [ ] / - [x]`       | `☐ / ☑`          |
 * | `- item`              | `• item`          |
 *
 * The conversion is applied in order: block-level elements first (headings,
 * rules, blockquotes, lists), then inline formatting (bold before italic)
 * to avoid accidentally re-processing substituted delimiters.
 *
 * @param text  Input text that may contain Markdown formatting.
 * @returns     Text with WhatsApp-compatible formatting codes substituted in.
 */
export function markdownToWhatsApp(text: string): string {
  const BOLD = "\x01"; // temp placeholder to protect WhatsApp bold from italic pass
  return text
    // Block-level: headings → bold uppercase (placeholder-wrapped)
    .replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) => `${BOLD}${title.toUpperCase()}${BOLD}`)
    // Block-level: horizontal rules → em dashes
    .replace(/^---+$/gm, "———")
    // Block-level: blockquotes → left bar
    .replace(/^>\s?(.*)$/gm, "▎ $1")
    // Block-level: checkboxes
    .replace(/^(\s*)- \[x\]\s+/gm, "$1☑ ")
    .replace(/^(\s*)- \[ \]\s+/gm, "$1☐ ")
    // Block-level: unordered list items → bullet
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    // Inline: bold **text** → placeholder-wrapped
    .replace(/\*\*(.+?)\*\*/gs, `${BOLD}$1${BOLD}`)
    // Inline: italic *text* → _text_ (only single asterisks not adjacent to other asterisks)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "_$1_")
    // Inline: code `text` → ```text```
    .replace(/`([^`]+)`/g, "```$1```")
    // Replace bold placeholders with WhatsApp bold
    .replace(new RegExp(BOLD, "g"), "*");
}
