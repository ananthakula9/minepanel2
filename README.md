# MinePanel

Run Minecraft servers from a website that lives **on your own Wi-Fi**. Install it once in Termux on your Android phone, then open it from any phone or PC at home to create, start, stop and manage servers. No cloud, no accounts, no database service. Everything stays on your phone.

There are no npm packages to install, so nothing can fail to install on Android.

## Install on your phone (Termux)

```bash
pkg update
pkg install nodejs-lts openjdk-21 git tar
git clone https://github.com/ananthakula9/minepanel2.git
cd minepanel2
termux-wake-lock
npm start
```

(`openjdk-17` works for Minecraft up to 1.20.4 if 21 isn't available.)

It prints your address, like `http://192.168.1.38:8080`. Open it on any phone or PC on the same Wi-Fi. The first time, you create the owner account.

**Update later:** `cd ~/minepanel2 && git pull`, then restart with Ctrl+C and `npm start`. Your servers and account live in `data/` and are not touched.

Keep Termux running. `termux-wake-lock` stops Android sleeping it, and you should also turn off battery optimisation for Termux. Ctrl+C stops everything; running servers are stopped safely first.

## What you can do

- **Dashboard:** every server with status, address, CPU, RAM and players; node (phone) CPU, RAM, storage, Java version, uptime and live charts.
- **Create servers:** Paper, Vanilla, or "I already have a server.jar". Each has its own folder, port and RAM limit. The jar is downloaded from Mojang or PaperMC and checksum-verified.
- **Power controls:** Start, Restart, Stop, Kill. A server is shown as Running only after Minecraft prints its "Done" line, and crashes are shown as Stopped with an error. Optional automatic restart after a crash (3 times per 10 minutes at most).
- **Console:** live logs, command box, ↑/↓ history, plus per-server CPU / memory / disk / players / uptime and live graphs.
- **Files:** browse, upload, download, create, rename, delete, edit text and config files.
- **Players:** who is online, kick / ban / op, whitelist on/off and add/remove, operator and ban lists (changes are applied by sending the normal Minecraft commands).
- **Plugins:** list installed plugins, enable/disable, remove, upload a `.jar`, and search/install from [Modrinth](https://modrinth.com) (filtered to your Minecraft version, checksum-verified).
- **Backups:** create (safe while the server runs), download, delete, and restore (server must be stopped). Up to 10 per server.
- **Online (ngrok):** let friends outside your home join. Paste your ngrok auth token, press Start tunnel, and the public address appears at the top of the server page and on the dashboard. See below.
- **Properties:** edit `server.properties` with a filter box. **Settings:** name, jar file, RAM, port, auto-restart, delete.

Players on your Wi-Fi join with `your-phone-ip:port`.

## Playing from outside your home (ngrok)

Open a server, then the **Online** tab. It walks you through three steps:

1. **Install ngrok** once: download the Linux ARM64 build from ngrok.com/download, then in Termux unpack it and `mv ngrok ~/`. The panel finds it on your PATH or at `~/ngrok`, and the tab has a Re-check button.
2. **Paste your auth token** from dashboard.ngrok.com/get-started/your-authtoken. It is stored only in `data/db.json` (owner-only permissions), is given to ngrok through an environment variable (not the command line), and is never sent back to the browser (only its last 4 characters are shown).
3. **Start tunnel.** The public address (like `0.tcp.ngrok.io:12345`) is shown in the server header and on the dashboard. Friends add it in Minecraft → Multiplayer.

Things to know: ngrok asks for a card on the account before allowing TCP tunnels (not charged on the free plan); the address changes every time you start a tunnel; the free plan allows one tunnel at a time and has a data limit; the tunnel is not restarted automatically when the panel restarts (if Termux was force-killed, run `pkill ngrok`). **Turn on `online-mode` before going public**; the tab warns you and has a one-tap button. If ngrok fails, the tab shows its output and a plain-language hint.

### Using your existing Paper server
Create a server with **"I already have a server.jar"**, then copy your files into its folder:
```bash
cp -r ~/your-old-server/* ~/minepanel2/data/servers/<server-id>/
```
`<server-id>` is the lowercase name shown inside `data/servers/`. If your jar isn't named `server.jar`, pick it in Settings. Your old folder is not modified.

## Security

- Everything requires login. Passwords are hashed (scrypt), sessions are HttpOnly SameSite=Strict cookies, repeated wrong logins are rate limited, and state-changing requests need a custom header.
- Console and player commands are only accepted from a logged-in user while the server is running. Player names and reasons are validated so they can't carry extra commands.
- File access is locked to the server's own folder (blocks `..`, absolute paths and symlink escapes). Backups are refused if they contain unsafe paths, links or special files.
- There is **no shell access** through the panel.
- Plain HTTP is fine inside your home network. **Do not port-forward the panel to the internet.**
- If you run with `online-mode=false`, player names are not verified: anyone on your network can join as any name, including an operator's. Only op people you trust.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Panel port |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to allow only the phone itself |
| `DATA_DIR` | `./data` | Accounts, servers and backups (back this up) |
| `JAVA` | `java` | Path to the Java binary |

## What has and hasn't been tested

**Automated (`npm test`, 37 tests, using a fake Java that behaves like a Minecraft server and a fake ngrok):** login/setup/rate limiting, validation, start/stop/restart/kill, "Running" only after the Done line, crash reporting and auto-restart (including giving up after 3 crashes), console, live metrics, players, plugins, backups (including hostile archives and the 10-backup limit), file manager traversal/symlink blocking, properties, settings, deletion. I also broke three safety checks on purpose and confirmed the tests caught each.

**Real browser (Chromium, desktop and phone size):** 18 click-through steps covering every page, with no JavaScript errors or security-policy violations.

**Confirmed on your phone:** the panel starts under Termux, a Paper server ran, and you joined it.

**Not tested:**
- The real ngrok program. The tests use a fake that prints the log format I expect. Unverified: the exact log line, the `NGROK_AUTHTOKEN` variable, and whether DNS works under Termux (if it doesn't, the tab suggests the optional termux-chroot switch, which is also untested on a real phone). The panel also asks ngrok's local API as a backup way to find the address.
- Live downloads from Mojang, PaperMC and Modrinth (needs internet, which my test environment doesn't have). The code is written against their APIs; if a download or search fails, the panel shows the exact error.
- Backups, plugins, players and graphs against a real Minecraft server (tested with the fake one).
- Backups depend on `tar`; install with `pkg install tar` if missing.
- CPU/RAM per server are read from `/proc`, which Android allows for the panel's own child processes. If your phone hides it, the numbers show as "—".

## Not built yet
Scheduled tasks (timed restarts/commands), multiple panel users, and automatic update of installed plugins.
