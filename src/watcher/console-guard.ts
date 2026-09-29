/**
 * console-guard.ts — keep Signal session key material out of the watcher log.
 *
 * libsignal prints SessionEntry objects (incl. privKey) straight to
 * console.info ("Closing session:", "Opening session:", ...), bypassing the
 * pino logger. The launchd log captures stdout/stderr, so drop those calls.
 */

const SESSION_DUMP = /^(Closing|Opening) session:|^Migrating session to:|^Removing old closed session:/;

/** True if a console call would emit libsignal session state or key material. */
export function isSessionDump(args: unknown[]): boolean {
  if (typeof args[0] === "string" && SESSION_DUMP.test(args[0])) return true;
  return args.some((a) => {
    if (a === null || typeof a !== "object") return false;
    // Cheap own-key probe; SessionEntry keeps keys in currentRatchet/indexInfo.
    const o = a as Record<string, unknown>;
    return "privKey" in o || "currentRatchet" in o || "ephemeralKeyPair" in o;
  });
}

export function installConsoleGuard(): void {
  for (const m of ["log", "info", "warn", "debug", "error"] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => {
      if (!isSessionDump(args)) orig(...args);
    };
  }
}
