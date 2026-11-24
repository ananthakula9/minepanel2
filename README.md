# MinePanel

Run Minecraft servers from a website that lives **on your own Wi-Fi**. Install it once in Termux on your Android phone, then open it from any phone or PC at home and create, start, stop and manage servers. No cloud, no Vercel, no database service, no accounts anywhere. Everything stays on your phone.

No npm packages are needed at all, so nothing can fail to install on Android.

## Install on your phone (Termux)

1. Install the tools (one time):
   ```bash
   pkg update
   pkg install nodejs-lts openjdk-21 unzip
   ```
   If `openjdk-21` isn't found, use `openjdk-17` (works for Minecraft up to 1.20.4).

2. Get the project into Termux. If you downloaded `minepanel2.zip` to your phone:
   ```bash
   termux-setup-storage
   cd ~
   unzip ~/storage/downloads/minepanel2.zip
   cd minepanel2
   ```

3. Start it:
   ```bash
   termux-wake-lock
   npm start
   ```
   It prints your address, like `http://192.168.1.23:8080`.

4. On any phone or PC on the same Wi-Fi, open that address. The first time, you create your owner account.

Keep Termux running. `termux-wake-lock` stops Android from putting it to sleep. Also turn off battery optimisation for Termux in Android settings. Stop everything with Ctrl+C; running servers are stopped safely first.

## Using it

- **Create Server**: pick Paper or Vanilla and a version, set the RAM and port, accept the EULA. The jar is downloaded from Mojang or PaperMC (the phone needs internet for this).
- **Console**: live logs, a command box, and ↑/↓ command history. Players join/leave counts come from the server log.
- **Files**: browse, upload, download, create, rename, delete, and edit text/config files.
- **Properties**: edit `server.properties` (appears after the first start).
- Each server has its own folder, port and RAM limit. Players connect to `your-phone-ip:port` on the same Wi-Fi.

### Using your existing Paper server
Create a server with **"I already have a server.jar"**, then copy your files into its folder:
```bash
cp -r ~/your-old-server/* ~/minepanel2/data/servers/<server-id>/
```
`<server-id>` is the lowercase name shown in the folder `data/servers/`. Your old server folder is not modified.

## Security

- Everything requires login. Passwords are hashed (scrypt), sessions are HttpOnly cookies, and repeated wrong logins are rate limited.
- Console commands are only accepted from a logged-in user, and only while the server is running.
- All file access is locked to the server's own folder (blocks `..`, absolute paths and symlink escapes).
- There is **no shell access** through the panel.
- It uses plain HTTP, which is fine inside your home network. **Do not port-forward the panel to the internet.** If you ever want outside access, put it behind a Cloudflare Tunnel with Cloudflare Access first.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Panel port |
| `HOST` | `0.0.0.0` | Use `127.0.0.1` to allow only the phone itself |
| `DATA_DIR` | `./data` | Where accounts and servers are stored (back this up) |
| `JAVA` | `java` | Path to the Java binary |

## Status: what has and hasn't been tested

Tested automatically (`npm test`, 18 tests, using a fake Java that behaves like a Minecraft server):
login/setup/logout, rate limiting, EULA and input validation, start/stop/restart/kill, "running" only after the server's Done line, crash reporting, console commands and log streaming, player join/leave tracking, file manager, path traversal and symlink blocking, properties editor, port changes, deletion.

**Not tested yet:**
- Running a real Minecraft jar (needs a machine with internet and Java; tested only with the fake).
- Paper/Vanilla version lists and jar downloads (need internet; written against the Mojang and PaperMC APIs).
- The web interface in a real browser (the script passes a syntax check and the server serves it, but I haven't clicked through it).
- Anything on a real Android phone.
- Plugin manager (Modrinth/Hangar), backups and restore, OP/whitelist/ban pages. These are **not built yet**. For now use console commands like `op Steve` or `whitelist add Steve`.

Run the tests yourself: `npm test`.
