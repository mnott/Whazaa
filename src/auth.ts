/**
 * auth.ts — Auth directory resolution and QR code display helper
 *
 * Whazaa stores session credentials in ~/.whazaa/auth/ by default.
 * Override with WHAZAA_AUTH_DIR environment variable.
 *
 * QR codes are printed to stderr so they never pollute MCP's JSON-RPC
 * stream on stdout.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";

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

/** Whether setup mode is active — controls QR display method */
let setupMode = false;

/** Enable setup mode (QR opens in browser instead of terminal) */
export function enableSetupMode(): void {
  setupMode = true;
}

/**
 * When true, QR display is suppressed (used during session verification
 * in setup mode so we don't open a browser tab just to check connectivity).
 */
let qrSuppressed = false;

/** Suppress QR display — call before a verification-only connection attempt. */
export function suppressQRDisplay(): void {
  qrSuppressed = true;
}

/** Re-enable QR display — call after verification, before a real pairing attempt. */
export function unsuppressQRDisplay(): void {
  qrSuppressed = false;
}

/** Path to the temporary QR HTML file (so we can clean it up) */
let qrHtmlPath: string | null = null;

/**
 * Print a QR code to stderr (MCP mode) or open in browser (setup mode).
 *
 * Baileys provides the raw QR string in its 'connection.update' event.
 * In MCP mode, the QR is rendered in the terminal on stderr.
 * In setup mode, an HTML page is generated and opened in the default browser.
 */
export function printQR(qrString: string): void {
  // During setup's verification phase, QR display is suppressed so we don't
  // open a browser tab merely to check whether an existing session is still valid.
  if (qrSuppressed) {
    process.stderr.write("[whazaa] QR suppressed during session verification.\n");
    return;
  }

  if (setupMode) {
    printQRBrowser(qrString).catch((err) => {
      process.stderr.write(`[whazaa] Browser QR failed: ${err}\n`);
      printQRTerminal(qrString);
    });
  } else {
    printQRTerminal(qrString);
  }
}

/** Clean up the temporary QR HTML file */
export function cleanupQR(): void {
  if (qrHtmlPath) {
    try { unlinkSync(qrHtmlPath); } catch { /* ignore */ }
    qrHtmlPath = null;
  }
}

function printQRTerminal(qrString: string): void {
  process.stderr.write("\n[whazaa] Scan the QR code below with WhatsApp:\n");
  process.stderr.write(
    "[whazaa] Open WhatsApp -> Linked Devices -> Link a Device\n\n"
  );

  qrcode.generate(qrString, { small: true }, (rendered: string) => {
    process.stderr.write(rendered + "\n");
  });

  process.stderr.write("[whazaa] Waiting for scan...\n\n");
}

async function printQRBrowser(qrString: string): Promise<void> {
  const svg = await QRCode.toString(qrString, { type: "svg", margin: 2, width: 300 });

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Whazaa — WhatsApp Pairing</title>
<style>
  body {
    margin: 0; min-height: 100vh;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    background: #111; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; }
  p { color: #aaa; margin-bottom: 2rem; font-size: 1.1rem; }
  .qr {
    background: #fff;
    padding: 24px; border-radius: 16px;
    display: flex; align-items: center; justify-content: center;
  }
  .qr svg { width: 280px; height: 280px; }
  .footer { margin-top: 2rem; color: #666; font-size: 0.9rem; }
</style>
</head><body>
<h1>Whazaa</h1>
<p>Scan with WhatsApp &rarr; Linked Devices &rarr; Link a Device</p>
<div class="qr">${svg}</div>
<p class="footer">This page will close automatically after pairing.</p>
</body></html>`;

  qrHtmlPath = join(tmpdir(), "whazaa-qr.html");
  writeFileSync(qrHtmlPath, html);

  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  exec(`${cmd} ${qrHtmlPath}`);

  console.log("QR code opened in your browser. Waiting for scan...");
}
