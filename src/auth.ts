/**
 * auth.ts — Auth directory resolution and QR code display helper
 *
 * Whazaa stores session credentials in ~/.whazaa/auth/ by default.
 * Override with WHAZAA_AUTH_DIR environment variable.
 *
 * QR codes are printed to stderr so they never pollute MCP's JSON-RPC
 * stream on stdout.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import qrcode from "qrcode-terminal";

/**
 * Resolve the auth directory, with the following priority:
 *   1. WHAZAA_AUTH_DIR environment variable
 *   2. ~/.whazaa/auth/ (default)
 *
 * Creates the directory if it does not exist.
 */
export function resolveAuthDir(): string {
  const dir = process.env.WHAZAA_AUTH_DIR ?? join(homedir(), ".whazaa", "auth");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    process.stderr.write(`[whazaa] Created auth directory: ${dir}\n`);
  }

  return dir;
}

/**
 * Return true if an existing auth session appears to be present.
 * Baileys writes creds.json when credentials are saved.
 */
export function hasExistingSession(authDir: string): boolean {
  const credsPath = join(authDir, "creds.json");
  return existsSync(credsPath);
}

/**
 * Print a QR code to stderr.
 *
 * Baileys provides the raw QR string in its 'connection.update' event.
 * We render it here so it appears in the user's terminal without
 * contaminating the MCP JSON-RPC stream on stdout.
 */
export function printQR(qrString: string): void {
  process.stderr.write("\n[whazaa] Scan the QR code below with WhatsApp:\n");
  process.stderr.write(
    "[whazaa] Open WhatsApp -> Linked Devices -> Link a Device\n\n"
  );

  // qrcode-terminal writes to stdout by default; we capture and re-emit to stderr
  qrcode.generate(qrString, { small: true }, (rendered: string) => {
    process.stderr.write(rendered + "\n");
  });

  process.stderr.write("[whazaa] Waiting for scan...\n\n");
}
