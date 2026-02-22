# Whazaa Lessons Learned

## Lesson: NEVER delete auth credentials without explicit user permission

**What went wrong**: Deleted `~/.whazaa/auth/` to trigger a re-pair, without the user asking for it. User had to scan QR multiple times and was frustrated.
**The rule**: Auth credentials are sacred. NEVER delete them unless the user explicitly says "delete auth" or "unpair". Ask first, always.
**Date**: 2026-02-22
**Severity**: High

## Lesson: NEVER send messages to third-party contacts without explicit permission

**What went wrong**: Sent "Merci, bonne journée!" and "." to Berrut Georgis to create message anchors, without the user's approval.
**The rule**: Only send messages to self-chat unless the user explicitly says to message someone else and provides the content.
**Date**: 2026-02-22
**Severity**: High

## Lesson: Pairing must happen in the watcher, not npx whazaa setup

**What went wrong**: Used `npx whazaa setup` for re-pairing, which runs a separate Baileys connection. The initial history sync was received and discarded by setup. The watcher then connected as a "reconnect" and got no history.
**The rule**: When re-pairing is needed for history sync, delete auth and let the watcher (launchd) restart — it shows QR and handles pairing directly, receiving the history sync into the store.
**Date**: 2026-02-22
**Severity**: Medium
