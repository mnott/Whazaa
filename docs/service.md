# CLI, launchd and Linux service

Back to the [README](../README.md).

```bash
# First-time setup: verify AIBroker and pair with WhatsApp
npx -y whazaa setup

# Run the adapter as a background service (LaunchAgent on macOS, systemd user unit on Linux)
whazaa service start          # stop | status | unit

# Or start it in the foreground (connects to the AIBroker hub on /tmp/aibroker.sock)
npx whazaa watch

# Remove stored credentials (stop the service first: whazaa service stop)
npx -y whazaa uninstall
```

## launchd agent

Whazaa runs as the `com.whazaa.watcher` launchd agent. It connects to the AIBroker hub at startup and heartbeats every 30 seconds to maintain its registration.

## Manual control

```bash
whazaa service start    # Install and start as launchd agent
whazaa service stop     # Stop and unload
whazaa service status   # Show running state
```

The agent uses `KeepAlive: true` and `ProcessType: Interactive`. The Interactive process type and `LimitLoadToSessionType: Aqua` are required so the adapter process can run in the macOS GUI session context.

> **Note:** Whazaa requires AIBroker to be running before it starts. If the hub is not available, Whazaa will retry the IPC connection on a backoff schedule.

## Linux

On Linux the adapter runs as a systemd user unit (`whazaa-watcher.service`); `whazaa service` (backed by `scripts/watcher-ctl.sh`, also usable directly from a git checkout) detects the platform via `uname`.

Prerequisites: Node 20+, systemd with a user session, tmux for terminal sessions, and the AIBroker hub running.

```bash
npm install -g whazaa
whazaa service start [session-id] # write ~/.config/systemd/user/whazaa-watcher.service, enable --now
whazaa service status               # systemctl --user status summary
whazaa service stop                 # disable --now and remove the unit
```

The unit carries the invoking shell's `PATH` and every `AIBROKER_*` / `WHAZAA_*` variable, runs with `UMask=0077` and `Restart=on-failure`. Logs go to `~/.local/state/whazaa/watch.log` (0600, directory 0700); the journal also shows unit lifecycle events (`journalctl --user -u whazaa-watcher`).

To keep the adapter running after you log out, enable linger once (the script prints this hint when linger is off; it never runs sudo):

```bash
sudo loginctl enable-linger "$USER"
```

