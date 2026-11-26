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
- **Online (playit.gg):** start the playit agent from the panel, save your tunnel address, and see it (with Copy) in the server header and dashboard. See below.
- **Properties:** edit `server.properties` with a filter box. **Settings:** name, jar file, RAM, port, auto-restart, delete.

Players on your Wi-Fi join with `your-phone-ip:port`.

## Playing from outside your home (playit.gg)

[playit.gg](https://playit.gg) gives your server a public address with no router settings. The panel runs the playit agent for you and shows the address; you make the tunnel itself on playit.gg.

**About India and ping, honestly:** playit has a datacenter in India (listed on playit.gg under Asia, with Singapore and Japan). On a free "Global Anycast" tunnel, each player is routed to the datacenter nearest them, decided mostly by their internet provider, so players in India normally reach the India one. You cannot force a region on a free tunnel, and recreating a free tunnel does not change it, so a "retry until it says India" loop would not work and I did not build one. Pinning a region is a **Playit Premium** feature (chosen when you create the tunnel on playit.gg, not changeable afterwards). To check where a player is routed, have them open `ping.playit.gg`. I can't promise a ping number.

Open a server, then the **Online** tab:
1. **Install the agent** (once). In Termux: `curl -SsL -o ~/playit https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-aarch64` then `chmod +x ~/playit`. The panel finds it on PATH or at `~/playit` (or set `PLAYIT=/full/path` in `.env`).
2. **Connect the agent.** Press **Start agent**. If it prints a claim link, the panel shows a button to open it; sign in to playit.gg. Or create an agent at playit.gg/account/agents and save its secret key in the tab (it is passed to the agent as the `SECRET_KEY` environment variable, never on the command line, and is not shown again).
3. **Create the tunnel** on playit.gg/account/tunnels: Minecraft Java, local address `localhost:<your server's port>`. Copy the address it gives you, paste it in the tab, and Save. It then appears (with Copy) in the server header and on the dashboard.

Players add that address in Minecraft. **Turn on `online-mode` before sharing it** (the tab warns you and has a one-tap button). `server-ip=` is kept blank (the panel resets it on start and the Properties editor won't change it).

If you used an older version, the panel deletes the old ngrok / DuckDNS settings and tokens from `data/db.json` on start. Stop a leftover ngrok program with `pkill ngrok`.

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
| `PLAYIT_SECRET` | (empty) | Optional playit agent secret key |
| `PLAYIT` | (auto) | Path to the playit program |

These can also go in a `.env` file in the project folder (see `.env.example`).

## What has and hasn't been tested

**Automated (`npm test`, 38 tests, using a fake Java that behaves like a Minecraft server and a fake playit agent):** login/setup/rate limiting, validation, start/stop/restart/kill, "Running" only after the Done line, crash reporting and auto-restart (including giving up after 3 crashes), console, live metrics, players, plugins, backups (including hostile archives and the 10-backup limit), file manager traversal/symlink blocking, properties, settings, deletion. I also broke three safety checks on purpose and confirmed the tests caught each.

**Real browser (Chromium, desktop and phone size):** 18 click-through steps covering every page, with no JavaScript errors or security-policy violations.

**Confirmed on your phone:** the panel starts under Termux, a Paper server ran, and you joined it.

**Not tested:**
- The real playit agent. The tests use a fake one. Unverified: that the real agent accepts the secret as `SECRET_KEY` (documented for its Docker image), prints a claim link when it has no secret, runs without a terminal on Termux, and keeps running when the screen is off. The panel shows the agent's own output so a failure is visible. The tunnel address is typed in by you; the panel does not look it up from playit.
- Live downloads from Mojang, PaperMC and Modrinth (needs internet, which my test environment doesn't have). The code is written against their APIs; if a download or search fails, the panel shows the exact error.
- Backups, plugins, players and graphs against a real Minecraft server (tested with the fake one).
- Backups depend on `tar`; install with `pkg install tar` if missing.
- CPU/RAM per server are read from `/proc`, which Android allows for the panel's own child processes. If your phone hides it, the numbers show as "—".

## Not built yet
Scheduled tasks (timed restarts/commands), multiple panel users, and automatic update of installed plugins.
