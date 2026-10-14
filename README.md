# vaultsync

Keeps your Obsidian vaults in sync between computers, phones and a NAS, using a private GitHub repo
instead of Obsidian Sync. Your notes stay plain Markdown files in a normal folder.

## How it fits together

Every vault is one private GitHub repo. Every device keeps its own copy of that repo (a git
"clone"), and GitHub sits in the middle:

```
                         ┌──────────────────────┐
                         │  GitHub (private)    │
                         │  one repo per vault  │
                         └──────────▲───────────┘
                                    │  push / pull
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────┴────────┐         ┌────────┴─────────┐        ┌────────┴────────┐
│ Desktop / Mac  │         │ Docker server    │        │ Phone           │
│ vaultsync      │         │ vaultsync        │        │ Obsidian Git    │
│ (background)   │         │ container        │        │ plugin          │
│ local clone    │         │ → NAS folders    │        │ local clone     │
└────────────────┘         │   (NFS), also    │        └─────────────────┘
                           │   used by Hermes │
                           └──────────────────┘
```

On a computer or server, vaultsync runs in the background and does this for each vault:

1. **You change a file.** vaultsync waits until nothing has changed for 30 seconds (so it doesn't
   commit half a sentence), then saves a snapshot (a git commit) and uploads it to GitHub.
2. **Every 5 minutes** it also downloads changes from the other devices, and uploads anything it
   missed.
3. **Two devices changed the same note** before syncing? Nothing is lost. The version on this
   device stays as `note.md`. The other version is saved next to it as
   `note.conflict-2026-10-13.md`. You merge them by hand and delete the conflict file.

Phones can't run vaultsync. They use the Obsidian Git plugin, which does roughly the same thing.

The full history of every note is in git: `git log -p -- "path/to/note.md"`.

## Important rules

- **One sync tool per folder.** Never point two sync mechanisms at the same folder: not two
  vaultsync instances, not vaultsync plus iCloud/Obsidian Sync, and not desktop Obsidian opening
  the NAS share directly. They overwrite each other's work.
- **Each device has its own copy.** Desktops and phones work on a local clone. Only the NAS copy
  lives on the NAS, and only the Docker container (and Hermes) touch it.
- **Don't let other tools run git in a vault.** Hermes may read and write notes, but only vaultsync
  runs git there.

## Setup overview

Do these in order. Step 2 publishes each vault to GitHub. Every other device clones it from there.

1. [Create a GitHub token](#1-create-a-github-token)
2. [NAS: run the Docker container](#2-nas-run-the-docker-container) (your vaults already live here)
3. [Desktop: switch to a local clone](#3-desktop-switch-to-a-local-clone)
4. [Phone: Obsidian Git plugin](#4-phone-obsidian-git-plugin)

Before you start, turn off Obsidian Sync on all devices (**Settings → Core plugins → Sync**) once it
has finished syncing.

### 1. Create a GitHub token

1. On GitHub, create one **empty private** repo per vault, for example `you/vault-werk`,
   `you/vault-prive`. Don't add a README or license; the repo must be empty.
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens):
   - *Repository access:* only the vault repos.
   - *Permissions:* **Contents → Read and write**. Nothing else.
3. Keep the token somewhere safe (a password manager). You'll paste it on each device.

### 2. NAS: run the Docker container

One container syncs all vaults. It mounts the same NAS folders that Hermes uses. Hermes just reads
and writes notes; the container commits and pushes them.

**a. Configure.** On the Docker server, in this folder:

```sh
cp compose.example.yml compose.yml
```

Edit `compose.yml`. The comments in it explain each line. You need to set:

- `volumes`: one line per vault, `<folder on the docker server>:/vaults/<Name>`.
- `VAULT_PATH`: the same `/vaults/<Name>` paths, separated by `:`.
- `user`: who owns the vault files on the NAS. Find it with `ls -ln /mnt/nas/obsidian` on the
  Docker server: the two numbers after the permissions are the uid and gid (for example `1026 100`).

Put the token in a file called `.env` next to `compose.yml` (Docker Compose reads it automatically):

```sh
GITHUB_TOKEN=github_pat_...
```

**b. First sync.** Stop Hermes first, so nothing changes during the first upload.

```sh
docker compose build                       # build the image
docker compose run --rm vaultsync init     # turn every vault folder into a git repo

# connect each vault to its GitHub repo (repeat per vault):
docker compose run --rm --entrypoint git vaultsync -C /vaults/Werk remote add origin https://github.com/you/vault-werk.git

docker compose run --rm vaultsync sync     # first upload of all vaults
```

Check GitHub: each repo should now contain your notes.

**c. Start it.**

```sh
docker compose up -d                       # runs in the background, restarts automatically
```

Start Hermes again. To check that everything works:

```sh
docker compose logs -f vaultsync           # live log, each line starts with [VaultName]
docker compose exec vaultsync node /app/bin/vaultsync.js status
```

Good to know:

- vaultsync notices Hermes' changes within seconds, because Hermes runs on the same Docker server.
  Changes made from elsewhere (for example directly on the NAS) are picked up by the 5-minute round.
- **Adding a vault later:** add it to `volumes` and `VAULT_PATH`, run `init`, `remote add` and
  `sync` as above, then `docker compose up -d`.

### 3. Desktop: switch to a local clone

Stop opening the NAS folder in Obsidian. Instead, each desktop gets its own copy.

**a. Install vaultsync** (once per computer). Requires [Node.js](https://nodejs.org) 20.12 or newer
and git.

```sh
cd path/to/vaultsync      # this folder
npm install
cp .env.example .env
```

Tell git who you are (used in commit messages):

```sh
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

**b. Clone each vault.** Use a folder outside `~/Documents`, `~/Desktop` and iCloud (see
[macOS notes](#macos)).

```sh
git clone -c core.autocrlf=false https://github.com/you/vault-werk.git ~/Vaults/Werk
```

`-c core.autocrlf=false` stops Windows from changing line endings. Without it every note looks
"changed" on every machine. When git asks for a password, paste the token.

**c. Configure.** Edit `.env` in this folder:

```sh
VAULT_PATH=/Users/you/Vaults/Werk:/Users/you/Vaults/Prive
GITHUB_TOKEN=github_pat_...
```

Then run once:

```sh
node bin/vaultsync.js init     # sets a few git options for every vault
node bin/vaultsync.js sync     # confirms that upload works
```

**d. Open in Obsidian:** **Open folder as vault** → `~/Vaults/Werk`, and so on.

**e. Run vaultsync in the background.** See [Run at login](#run-at-login).

Have notes that exist only on this desktop? Copy them into the clone. vaultsync uploads them.

### 4. Phone: Obsidian Git plugin

The phone gets its own copy too, and only talks to GitHub.

1. In Obsidian, create an empty vault. On iOS, store it **On My iPhone**, not in iCloud.
2. **Settings → Community plugins**: install and enable **Git**.
3. In the Git plugin settings, under authentication: your GitHub username, and the token as the
   password. Set the author name to something like `phone`.
4. Run the command **Clone an existing remote repo** with `https://github.com/you/vault-werk.git`.
   Clone into the vault root, then restart Obsidian.
5. Plugin settings: **Pull on startup** on, **Auto commit-and-sync interval** 5,
   **Auto pull interval** 5.

**Then, on every desktop:** open **Settings → Git** and turn on **Disable on this device**. The
plugin's on/off switch is part of the vault, so step 2 also turns it on on your desktops, where it
would fight vaultsync. "Disable on this device" is stored only on that device.

If the plugin is slow (large vault, many images, mostly on iOS), use a separate git app instead:
[Working Copy](https://workingcopy.app) on iOS (*Link Repository to Folder*; pushing is a paid
feature) or [MGit](https://github.com/maks/MGit) on Android. With those, you pull by hand before
editing and commit + push when you're done.

On a phone, a conflict shows up as `<<<<<<<` markers inside the note, not as a `.conflict-` file.
Pulling before you edit makes this rare.

## Reference

### Commands

On a desktop: `node bin/vaultsync.js <command>` (or `vaultsync <command>` after `npm link`).
In Docker: `docker compose run --rm vaultsync <command>`.

| Command  | What it does                                                                       |
| -------- | ---------------------------------------------------------------------------------- |
| `watch`  | Keeps running: syncs at start, 30 s after the last change, and every 5 minutes.    |
| `sync`   | Syncs once: commit everything, download, upload. Then exits.                       |
| `status` | Shows per vault: last download/upload, unsynced files, last error, conflict files. |
| `init`   | Makes each folder a git repo (if needed) and adds the standard `.gitignore`.       |

Sample `status` output:

```
vault        /Users/you/Vaults/Werk
branch       main  (ahead 0, behind 0 as of last fetch)
uncommitted  0 file(s)
last pull    13-10-2026, 14:04:26 (3m ago)
last push    13-10-2026, 14:04:27 (3m ago)
conflicts    1 outstanding:
  Projects/plan.conflict-2026-10-13.md
```

*ahead* = snapshots not yet uploaded, *behind* = snapshots on GitHub not yet downloaded.

### Settings

In `.env` (desktop) or `environment:` in `compose.yml` (Docker):

| Setting                 | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `VAULT_PATH`            | Vault folder(s). Several: separate with `:` (on Windows `;`).                     |
| `GITHUB_TOKEN`          | The token from step 1. Leave empty to use git's own saved login instead.          |
| `DEBOUNCE_SECONDS`      | Quiet time after a change before syncing. Default 30.                            |
| `PULL_INTERVAL_SECONDS` | How often to sync anyway. Default 300 (5 minutes).                               |

The token is handed to git only while vaultsync runs. It is never written into the vault, the git
config or the repo URL.

### Log and state files

vaultsync keeps two files inside each vault's hidden `.git/` folder. They are never uploaded.

- `.git/vaultsync.log`: every commit, download, upload and conflict.
- `.git/vaultsync.json`: time of the last download/upload and the last error (used by `status`).

### What is synced

Everything in the vault, except what the vault's `.gitignore` excludes:

- `.obsidian/workspace*`: which panes and files are open. Changes on every click and differs per
  device.
- `.trash/`: Obsidian's local trash.
- System junk: `.DS_Store`, `Thumbs.db`, `desktop.ini`.

The rest of `.obsidian/` (settings, themes, plugins) **is** synced. To keep a file per device, add
it to the vault's `.gitignore`.

### Conflicts

A conflict happens when two devices change the same file before either has synced.

| This device | Other device | Result                                                                  |
| ----------- | ------------ | ----------------------------------------------------------------------- |
| edited      | edited       | `note.md` = this device's version. Other version → `note.conflict-YYYY-MM-DD.md`. |
| deleted     | edited       | `note.md` stays deleted. Other version → `note.conflict-YYYY-MM-DD.md`. |
| edited      | deleted      | `note.md` = this device's version. No conflict file.                    |

- The date is the day the conflict was found. A second conflict on the same day gets `-2`, `-3`, …
- It works for any file type (images too); the extension is kept.
- Conflict files sync like normal notes, so every device sees them.
- `status` lists all conflict files still in the vault.

**To resolve:** open both files in Obsidian, copy what you want into `note.md`, delete the
`.conflict-…` file. vaultsync syncs the result.

If vaultsync crashes in the middle of this, the next sync finishes the job. If git gets stuck for
any other reason, vaultsync undoes the download attempt, leaves your own changes untouched, and
shows the error in `status`.

## Run at login

Desktops only. Docker restarts the container itself.

### macOS

Create `~/Library/LaunchAgents/com.you.vaultsync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.you.vaultsync</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string><string>/Users/you/vaultsync/bin/vaultsync.js</string><string>watch</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/vaultsync.log</string>
  <key>StandardErrorPath</key><string>/tmp/vaultsync.log</string>
</dict></plist>
```

Then: `launchctl load ~/Library/LaunchAgents/com.you.vaultsync.plist`.

- Use full paths. `which node` shows where node is (`/opt/homebrew/bin/node` on Apple Silicon).
- macOS blocks background programs from `~/Documents`, `~/Desktop` and iCloud Drive. Keep the
  vaults and this tool elsewhere (for example `~/Vaults`), or give `node` Full Disk Access in
  **System Settings → Privacy & Security**.
- Don't put a vault in iCloud Drive: two sync tools on one folder fight.

### Windows

In PowerShell (runs hidden at login, restarts if it crashes):

```powershell
$node = (Get-Command node).Source
$script = "C:\path\to\vaultsync\bin\vaultsync.js"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -NoProfile -Command `"& '$node' '$script' watch`""
Register-ScheduledTask -TaskName vaultsync -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
  -Action $action -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))
Start-ScheduledTask vaultsync
```

### Linux

Create `~/.config/systemd/user/vaultsync.service`, then run
`systemctl --user enable --now vaultsync`:

```ini
[Service]
ExecStart=/usr/bin/node /path/to/vaultsync/bin/vaultsync.js watch
Restart=on-failure

[Install]
WantedBy=default.target
```

## Troubleshooting

| Problem                                       | Cause and fix                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `VAULT_PATH is not set`                       | No `.env` (desktop) or no `VAULT_PATH` in `compose.yml` (Docker).       |
| `... is not a git repo`                       | Run `init` first, or clone the vault (desktop).                         |
| `Permission denied` in Docker                 | `user:` in `compose.yml` doesn't match the owner of the NAS folders.    |
| Push fails with 403 / authentication          | Token expired or lacks *Contents: Read and write* on that repo.        |
| Every note shows as changed on Windows        | Clone was made without `-c core.autocrlf=false`. Re-clone with it.      |
| Changes on the NAS appear only after minutes  | Normal for edits not made via the Docker server; the 5-minute round picks them up. |
| Vault was already a git repo with `.obsidian/workspace*.json` in it | Run once: `git rm --cached ".obsidian/workspace*.json"` in the vault. |
