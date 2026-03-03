/**
 * Re-export all iTerm2 primitives from aibroker.
 */
export {
  runAppleScript,
  stripItermPrefix,
  withSessionAppleScript,
  sendKeystrokeToSession,
  sendEscapeSequenceToSession,
  typeIntoSession,
  pasteTextIntoSession,
  findClaudeSession,
  isClaudeRunningInSession,
  isItermRunning,
  isItermSessionAlive,
  isScreenLocked,
  writeToTty,
  snapshotAllSessions,
} from "aibroker";
export type { SessionSnapshot } from "aibroker";
