# vaultsync

Syncs an Obsidian vault through a private GitHub repo, replacing Obsidian Sync. The vault stays a
folder of plain Markdown on disk. Git does the transport, and `git log` is the history.

- **Watcher:** commits and pushes 30 s after your last change.
- **Pull:** runs at start and every 5 min with `--rebase`.
- **Conflicts:** never lose data. Your version stays in place, and the incoming version is saved next
  to it as `<name>.conflict-YYYY-MM-DD.<ext>` and logged.
- **Network:** the only network traffic is git talking to GitHub. No accounts besides GitHub, no
  telemetry.

Out of scope: encrypted vaults and a history UI (use `git log -p -- "path/to/note.md"`).

## Install the tool (each desktop machine)

Requires Node ≥ 20.12 and git.

```sh
cd path/to/vaultsync      # this folder
npm install
npm link                  # puts `vaultsync` on your PATH
cp .env.example .env      # then set VAULT_PATH
```

Make sure git knows who you are, since commits use it:

```sh
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

### Credentials

Use one of these:

1. **System credential helper (recommended).** Git for Windows ships Git Credential Manager, and
   macOS has the keychain helper. Run any `git push` in the vault once by hand and sign in. After
   that, vaultsync uses the stored credential. Leave `GITHUB_TOKEN` empty.
2. **Token in `.env`.** Create a [fine-grained token](https://github.com/settings/personal-access-tokens)
   limited to the vault repo, with only *Contents: Read and write*. Put it in `GITHUB_TOKEN`.
   vaultsync gives it to git through env-scoped config. It is never written to `.git/config`, the
   remote URL or a command line. `.env` is gitignored.

## First machine (the vault already exists)

1. In Obsidian, turn off **Settings → Core plugins → Sync** once it has finished syncing.
2. Create an **empty private** repo on GitHub, for example `you/vault`.
3. Initialize and push:

   ```powershell
   vaultsync init                                   # git init, core.autocrlf=false, .gitignore
   # Type the real vault path. VAULT_PATH only exists in .env, not in your shell.
   git -C "C:\path\to\Vault" remote add origin https://github.com/you/vault.git
   vaultsync sync                                   # first commit + push
   ```

4. Start the watcher (see [Run at login](#run-at-login)).

If the vault was already a git repo that tracked `.obsidian/workspace*.json`, untrack those files
once: `git -C "C:\path\to\Vault" rm --cached ".obsidian/workspace*.json"`.

## Second machine

1. Install the tool as above.
2. Clone the vault with line-ending conversion **off**. Otherwise Git for Windows rewrites every
   note to CRLF and each machine keeps "changing" every file:

   ```sh
   git clone -c core.autocrlf=false https://github.com/you/vault.git ~/Vault
   ```

3. Set `VAULT_PATH` in `.env` to the clone, then run `vaultsync init`. On a clone this only sets
   the git config, because `.gitignore` is already in the repo.
4. In Obsidian: **Open folder as vault** → the clone. Keep the Obsidian Sync core plugin off.
5. Run `vaultsync sync` once to confirm push access, then start the watcher.

Don't point vaultsync at an existing local copy of the notes. Clone fresh, then copy in any notes
that exist only on that machine. The watcher commits them.

## Commands

| Command            | What it does                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| `vaultsync watch`  | Daemon: sync on start, 30 s after the last change, and every 5 min.         |
| `vaultsync sync`   | One shot: commit everything, pull `--rebase`, push.                         |
| `vaultsync status` | Last pull/push time, ahead/behind, uncommitted count, last error, conflict files. |
| `vaultsync init`   | `git init` if needed, set `core.autocrlf=false`, add the `.gitignore` entries. |

Sample `vaultsync status` output:

```
vault        C:\Users\you\Documents\Vault
branch       main  (ahead 0, behind 0 as of last fetch)
uncommitted  0 file(s)
last pull    13-10-2026, 14:04:26 (3m ago)
last push    13-10-2026, 14:04:27 (3m ago)
conflicts    1 outstanding:
  Projects/plan.conflict-2026-10-13.md
```

Settings in `.env`: `VAULT_PATH` (several vaults separated by `:`, `;` on Windows), `GITHUB_TOKEN`, `DEBOUNCE_SECONDS` (default 30),
`PULL_INTERVAL_SECONDS` (default 300).

Device-local state lives inside the vault's `.git/` folder and is never committed:

- `.git/vaultsync.json`: last pull, last push, last error.
- `.git/vaultsync.log`: every commit, pull, push and conflict.

## Conflict-file convention

A conflict happens when two devices change the same file before either one has synced. During the
rebase, vaultsync resolves each conflicting file the same way:

| Your side | Incoming side | Result                                                                   |
| --------- | ------------- | ------------------------------------------------------------------------ |
| edited    | edited        | Your version stays at `note.md`. Theirs goes to `note.conflict-YYYY-MM-DD.md`. |
| deleted   | edited        | `note.md` stays deleted. Theirs goes to `note.conflict-YYYY-MM-DD.md`.  |
| edited    | deleted       | Your version stays at `note.md`. No conflict file, because there is nothing incoming to save. |

How the files are named and handled:

- **Date:** the local date when the conflict was resolved.
- **Repeat clashes:** a second clash on the same file and day becomes
  `note.conflict-YYYY-MM-DD-2.md`, then `-3`, and so on.
- **Extensions:** they are kept (`diagram.conflict-2026-10-13.png`), and binary files are copied
  byte-for-byte.
- **Sync:** conflict files are committed and pushed like any other note, so every device sees them.
- **Log:** each conflict is logged as `CONFLICT <path>: kept local version, incoming saved as <file>`.

To resolve one, open both files in Obsidian, merge what you want into `note.md`, and delete the
`.conflict-…` file. The watcher syncs the result. `vaultsync status` lists every conflict file
still in the vault.

Failure handling:

- **Crash mid-rebase:** if vaultsync dies during a rebase, the next sync finishes it.
- **Other rebase failures:** if a rebase stops for any reason other than a file conflict, vaultsync
  aborts it. Your local commits are untouched. The error appears in `status` and the log.

## Run at login

**Windows** (Task Scheduler, PowerShell). The console window is hidden. Output also goes to
`.git\vaultsync.log`.

```powershell
$node = (Get-Command node).Source
$script = "C:\path\to\vaultsync\bin\vaultsync.js"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -NoProfile -Command `"& '$node' '$script' watch`""
Register-ScheduledTask -TaskName vaultsync -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
  -Action $action -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))
Start-ScheduledTask vaultsync
```

**macOS:** `~/Library/LaunchAgents/com.you.vaultsync.plist`, then
`launchctl load ~/Library/LaunchAgents/com.you.vaultsync.plist`.

- **Paths:** use absolute paths. `which node` gives the node path: `/opt/homebrew/bin/node` on Apple
  Silicon with Homebrew, `/usr/local/bin/node` on Intel. launchd ignores your shell `PATH`, so the
  plist sets one.
- **Privacy:** macOS blocks background processes from reading `~/Documents`, `~/Desktop` and
  iCloud Drive. Keep the vault outside those folders (for example `~/Vault`) and keep this tool
  outside them too. Otherwise grant `node` Full Disk Access in System Settings → Privacy & Security.
- **iCloud:** don't put the vault in iCloud Drive; two sync engines on one folder will fight.

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

**Linux:** `~/.config/systemd/user/vaultsync.service`, then
`systemctl --user enable --now vaultsync`.

```ini
[Service]
ExecStart=/usr/bin/node /path/to/vaultsync/bin/vaultsync.js watch
Restart=on-failure

[Install]
WantedBy=default.target
```

## Server / NAS (Docker)

Use this when a vault lives on a NAS share that other containers (for example AI agents) read and
write. The share counts as one more device. One vaultsync container syncs all vaults: list them in
`VAULT_PATH`, separated by `:`, and mount each one on the same host path the other containers use.
Those containers just write files. They never run git. Each vault is its own GitHub repo.

- **One writer per `.git`:** never run two vaultsync instances, or git from another container, on
  the same vault folder. Concurrent git processes race on `index.lock`, and that is worse over NFS.
- **Watcher over NFS:** writes from containers on the same docker host trigger the watcher. Writes
  from other NFS/SMB clients (or the NAS itself) don't, but the 5-minute sync still commits them.
- **Don't open the share directly in desktop Obsidian.** Desktops use their own clone (see
  [Second machine](#second-machine)). Otherwise two sync mechanisms work on one folder.
- **Ownership:** set `user:` to the uid:gid that owns the files on the share (`ls -ln` on the docker
  host). The image already trusts every directory (`safe.directory`), because the owner and the
  container user differ.
- **Token:** `GITHUB_TOKEN` comes from the environment (no `.env` in the image). One fine-grained
  token can cover all vault repos. Commits are authored by the `GIT_AUTHOR_*` values in compose.
- **One uid for all vaults:** the container runs as one user, so that user must be able to write
  every vault folder.

Setup. Stop the containers that write to the vaults first, so the first commit is consistent:

```sh
cp compose.example.yml compose.yml        # set paths, VAULT_PATH and user
export GITHUB_TOKEN=github_pat_...         # or put it in a .env next to compose.yml
docker compose build
docker compose run --rm vaultsync init     # all vaults in VAULT_PATH
# once per vault:
docker compose run --rm --entrypoint git vaultsync -C /vaults/Werk remote add origin https://github.com/you/vault-werk.git
docker compose run --rm vaultsync sync     # first commit + push, all vaults
docker compose up -d                       # start the watcher, then restart the agent containers
docker compose exec vaultsync node /app/bin/vaultsync.js status
```

Log lines are prefixed with the vault folder name, for example `[Werk] pushed main`. To add a vault
later, append it to `VAULT_PATH` and `volumes`, run `init`, `remote add` and `sync` for it, then
`docker compose up -d`.

Then switch each desktop to a fresh local clone of the repo.

## What is synced

Everything in the vault except what `.gitignore` excludes:

- `.obsidian/workspace*`: open panes and last-opened file. This changes on every click, and
  `workspace-mobile.json` is per device, so syncing it would ping-pong between machines.
- `.trash/`: Obsidian's local trash.
- OS cruft: `.DS_Store`, `Thumbs.db`, `desktop.ini`.

The rest of `.obsidian/` (settings, themes, plugins and their data) is synced. To keep something
per-device, add it to the vault's `.gitignore`.

## Mobile

vaultsync doesn't run on a phone. The phone is just another clone of the same repo, synced by a git
client inside or next to Obsidian. The NAS setup doesn't matter to the phone; it only talks to GitHub.

### Recommended: the Obsidian Git plugin (iOS and Android)

The community plugin [Obsidian Git](https://github.com/Vinzent03/obsidian-git) runs inside Obsidian
mobile, so pulling and pushing happen automatically, much like vaultsync on a desktop.

1. In Obsidian, create an empty vault on the phone. On iOS, store it *On My iPhone*, not in iCloud.
2. Install and enable **Git** from Community plugins.
3. In the plugin settings, enter your GitHub username and a fine-grained token (only *Contents:
   Read and write* on the vault repo) as the password. Set the author name, for example `phone`.
4. Run the command **Clone an existing remote repo** with `https://github.com/you/vault.git`, clone
   into the vault root, and restart Obsidian.
5. Settings: **Pull on startup** on, **Auto commit-and-sync interval** 5 minutes, **Auto pull
   interval** 5 minutes.

**Turn the plugin off on every desktop and on the NAS.** `.obsidian/community-plugins.json` and the
plugin folder are synced, so after step 2 the plugin also switches on everywhere else and fights
vaultsync. On each desktop, open the plugin settings and enable **Disable on this device**. That
setting is per device and isn't synced. The NAS vault isn't opened in Obsidian, so the plugin never
runs there.

Limits: the plugin uses a JavaScript git implementation. Large vaults or many attachments make it
slow and memory-hungry, especially on iOS. In that case, use one of the apps below.

### Alternative: a separate git app

**iOS: [Working Copy](https://workingcopy.app)** (pushing requires the paid unlock). Clone the repo,
then use **Link Repository to Folder** on an empty vault in *On My iPhone → Obsidian*. Routine: pull
before editing, commit + push after. Shortcuts automations ("When Obsidian opens/closes") can do this
for you.

**Android: [MGit](https://github.com/maks/MGit).** Clone into shared storage (for example
`Documents/Vault`) with your username and token, then **Open folder as vault** in Obsidian. Same
routine: pull before editing, commit and push after.

Mobile clients don't use the `.conflict-…` convention. If a mobile pull reports a merge conflict,
resolve it in the app or stash your phone's change and re-pull. Pulling before every edit makes
conflicts rare. The `.gitignore` already excludes `workspace-mobile.json`.
