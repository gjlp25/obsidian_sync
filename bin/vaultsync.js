#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { openVault, sync, status, init, log } from '../src/sync.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const { VAULT_PATH, GITHUB_TOKEN, DEBOUNCE_SECONDS = '30', PULL_INTERVAL_SECONDS = '300' } = process.env;
const command = process.argv[2];
// Several vaults can share one process: VAULT_PATH=/vaults/a:/vaults/b (";" on Windows).
const vaultPaths = (VAULT_PATH ?? '').split(path.delimiter).filter(Boolean);

const USAGE = `usage: vaultsync <command>

  init     git-init the vault (if needed) and add the standard .gitignore entries
  watch    run the sync daemon: commit+push ${DEBOUNCE_SECONDS}s after the last change, pull every ${PULL_INTERVAL_SECONDS}s
  sync     one-shot commit, pull --rebase, push
  status   last push/pull, pending changes, outstanding conflict files

Config comes from ${path.join(root, '.env')} (see .env.example).`;

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  const rel = s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return `${new Date(iso).toLocaleString()} (${rel} ago)`;
}

function watch(v) {
  let timer = null;
  let chain = Promise.resolve();
  const run = (why) => {
    chain = chain.then(() => sync(v)).catch((err) => log(v, `sync failed (${why}): ${err.message.trim()}`));
  };

  // Mirror the vault .gitignore for the noisy paths so clicking around Obsidian does not trigger syncs.
  const ignored = (p) => {
    const rel = path.relative(v.dir, p).split(path.sep).join('/');
    return /^(\.git|\.trash)(\/|$)/.test(rel) || rel.startsWith('.obsidian/workspace');
  };
  chokidar.watch(v.dir, { ignored, ignoreInitial: true }).on('all', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run('change');
    }, Number(DEBOUNCE_SECONDS) * 1000);
  });

  // A pending debounce will sync within seconds anyway, and skipping avoids committing mid-edit.
  setInterval(() => timer || run('interval'), Number(PULL_INTERVAL_SECONDS) * 1000);
  log(v, `watching ${v.dir}`);
  run('start');
}

async function printStatus(v) {
  const s = await status(v);
  const lines = [
    `vault        ${s.vault}`,
    `branch       ${s.branch}` + (s.ahead === null ? '  (no upstream yet)' : `  (ahead ${s.ahead}, behind ${s.behind} as of last fetch)`),
    `uncommitted  ${s.uncommitted} file(s)`,
    `last pull    ${ago(s.lastPull)}`,
    `last push    ${ago(s.lastPush)}`,
  ];
  if (s.lastError) lines.push(`last error   ${s.lastError}`);
  if (s.rebaseInProgress) lines.push(`WARNING      a rebase is in progress; the next sync will resolve it`);
  if (s.stashes) lines.push(`WARNING      ${s.stashes} stash entr${s.stashes === 1 ? 'y' : 'ies'} (git stash list); local edits may be parked there`);
  lines.push(s.conflicts.length ? `conflicts    ${s.conflicts.length} outstanding:` : 'conflicts    none');
  for (const f of s.conflicts) lines.push(`  ${f}`);
  console.log(lines.join('\n'));
}

async function main() {
  if (!['init', 'watch', 'sync', 'status'].includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
  if (!vaultPaths.length) throw new Error(`VAULT_PATH is not set; copy .env.example to ${path.join(root, '.env')}`);

  if (command === 'init') {
    for (const p of vaultPaths) {
      fs.mkdirSync(p, { recursive: true });
      const added = await init(openVault(p), path.join(root, 'vault.gitignore'));
      console.log(`${p}: ` + (added.length ? `added to .gitignore: ${added.join(', ')}` : '.gitignore already up to date'));
    }
    return;
  }

  const vaults = vaultPaths.map((p) => openVault(p, GITHUB_TOKEN));
  for (const v of vaults) {
    if (!fs.existsSync(path.join(v.dir, '.git'))) throw new Error(`${v.dir} is not a git repo; run "vaultsync init" or clone it first`);
  }
  if (command === 'watch') return vaults.forEach(watch);
  for (const v of vaults) {
    if (command === 'sync') await sync(v);
    else await printStatus(v);
  }
}

main().catch((err) => {
  console.error(`vaultsync: ${err.message.trim()}`);
  process.exit(1);
});
