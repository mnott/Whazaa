# WhatsApp commands

Back to the [README](../README.md).

Certain messages sent from your phone are intercepted by the hub and handled as commands rather than forwarded to Claude.

| Command | Description |
|---------|-------------|
| `/relocate <path>` or `/r <path>` | Open a new iTerm2 tab in the given directory and start Claude there |
| `/t` or `/t <command>` | Open a plain terminal tab (no Claude); optionally run a command |
| `/sessions` or `/s` | List open sessions (Claude and terminal) with names; reply `/N` to switch, `/N name` to switch and rename |
| `/ss` or `/screenshot` | Capture the active Claude session's iTerm2 window and send it back as an image |
| `/kill N` or `/k N` | Kill a stuck session (Claude: restarts it; terminal: closes the tab) |
| `/cc` | Send Ctrl+C to the active session (interrupt) |
| `/esc` | Send Escape to the active session |
| `/enter` | Send Enter/Return to the active session |
| `/tab` | Send Tab to the active session (trigger completion) |
| `/up` `/down` `/left` `/right` | Send arrow keys to the active session |
| `/pick N` | Select menu option N: send down arrow (N-1) times then Enter |
| _(image)_ | Send an image -- the hub downloads it and types the path into Claude |
| _(voice note)_ | Send a voice note -- the hub transcribes it with Whisper and types the text into Claude |

## /relocate

```
/relocate ~/projects/myapp
/r ~/projects/myapp
```

If a Claude session is already open in that directory, the hub focuses it instead of creating a new tab. Tilde expansion is supported.

After relocating, subsequent messages are delivered to the new session.

## /t (terminal)

```
/t
/t ls -la
/t htop
```

Opens a plain terminal tab in iTerm2 -- no Claude, just a shell. If you include a command, it runs immediately. The new tab is registered so it appears in `/s` alongside your Claude sessions, and you can switch to it with `/N`.

Once a terminal tab is active, any text you send from WhatsApp is typed directly into it. This gives you full control of your computer from your phone -- run shell commands, monitor processes, tail logs, or do anything you'd do at a terminal.

Switch back to a Claude session anytime with `/N`.

## /sessions

Reply `/s` to get a numbered list of all open sessions -- both Claude sessions and terminal tabs opened via `/t`. The currently active session is marked. Terminal sessions are labeled `[terminal]`.

Switch to a session with `/1`, `/2`, etc. Switch and rename in one step with `/1 My Project`. Session names persist across adapter restarts.

## /ss (screenshot)

```
/ss
/screenshot
```

Captures the active Claude session's iTerm2 window and sends it back as a WhatsApp image. The hub finds the session, selects its tab, raises its window to the foreground, waits for macOS to redraw, then captures the screen region.

Session resolution for screenshots follows this priority:

1. **Active session** -- set by `/N` switch commands
2. **Auto-discover** -- scans iTerm2 for any session running Claude
3. **Frontmost window** -- last resort if no Claude sessions exist

If you have multiple Claude sessions, use `/s` then `/N` to select the one you want before taking a screenshot.

## /kill

```
/kill 1
/k 2
```

Kill a session by its number from `/s`. Behavior depends on session type:

- **Claude session** -- sends SIGTERM to the Claude process, waits for the shell prompt to return, then types `claude` to restart in the same directory.
- **Terminal session** -- sends Ctrl+C to interrupt any running process, then closes the iTerm2 tab and removes it from the session list.

Use `/s` first to see which number corresponds to which session.

## Keyboard control

Send raw keystrokes to the active iTerm2 session without forwarding text to Claude. Useful for controlling interactive TUIs, navigating menus, and cancelling operations from your phone.

| Command | Keystroke | Use case |
|---------|-----------|----------|
| `/cc` | Ctrl+C | Interrupt a running process |
| `/esc` | Escape | Dismiss a dialog, exit a mode |
| `/enter` | Return | Confirm a prompt |
| `/tab` | Tab | Trigger shell completion |
| `/up` | Up arrow | Previous history item / menu up |
| `/down` | Down arrow | Next history item / menu down |
| `/left` | Left arrow | Move cursor left |
| `/right` | Right arrow | Move cursor right |
| `/pick N` | Down x(N-1) + Enter | Select the Nth option in a menu |

**Example -- navigate a fuzzy finder:**

```
/down
/down
/pick 3
```

`/pick 3` is equivalent to pressing down twice then Enter -- it selects the third item in any numbered or navigable list.

All keyboard commands require an active session. If none is set, the hub replies with a prompt to use `/s` and `/N`.

## Image forwarding

Send an image to your WhatsApp self-chat and the hub will download it to a temp file and type the path into your active Claude session:

```
/tmp/whazaa-img-a3f92b.jpg
```

If the image has a caption, it is appended on the same line:

```
/tmp/whazaa-img-a3f92b.jpg Describe this image
```

Claude Code can read image files natively, so it will process the image immediately without any extra steps.

Supported formats: JPEG, PNG, WebP, GIF, and stickers.

