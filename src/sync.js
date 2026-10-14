import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

// note.md -> note.conflict-2026-10-13.md (or note.conflict-2026-10-13-2.md on a second clash that day)
export const CONFLICT_RE = /\.conflict-\d{4}-\d{2}-\d{2}(-\d+)?(\.[^./]*)?$/;

export function openVault(vaultPath, token) {
  const dir = path.resolve(vaultPath);
  if (!token) return { dir, git: simpleGit(dir) };
  // Hand the token to git via env-scoped config so it never lands in .git/config or on a command
  // line. simple-git strips ambient GIT_* variables unless they are explicitly allowed.
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const tokenEnv = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
  Object.assign(process.env, tokenEnv);
  const git = simpleGit({
    baseDir: dir,
    allowEnvironment: Object.keys(tokenEnv),
    unsafe: { allowUnsafeConfigEnvCount: true },
  });
  return { dir, git };
}

// --- device-local state, kept inside .git so it is never committed ---

const gitFile = (v, name) => path.join(v.dir, '.git', name);
const now = () => new Date().toISOString();

export function readState(v) {
  try {
    return JSON.parse(fs.readFileSync(gitFile(v, 'vaultsync.json'), 'utf8'));
  } catch {
    return {};
  }
}

function saveState(v, patch) {
  fs.writeFileSync(gitFile(v, 'vaultsync.json'), JSON.stringify({ ...readState(v), ...patch }, null, 2));
}

export function log(v, msg) {
  const line = `${now()} ${msg}`;
  // The vault name tells lines apart when one process watches several vaults.
  console.log(`${now()} [${path.basename(v.dir)}] ${msg}`);
  fs.appendFileSync(gitFile(v, 'vaultsync.log'), line + '\n');
}

// --- git helpers ---

const count = async (v, range) => Number((await v.git.raw(['rev-list', '--count', range])).trim());
const rebaseInProgress = (v) =>
  fs.existsSync(gitFile(v, 'rebase-merge')) || fs.existsSync(gitFile(v, 'rebase-apply'));

// HEAD is detached while a rebase is stopped; the branch being rebased is recorded in head-name.
async function branchName(v) {
  const headName = gitFile(v, 'rebase-merge/head-name');
  if (fs.existsSync(headName)) return fs.readFileSync(headName, 'utf8').trim().replace(/^refs\/heads\//, '');
  return (await v.git.raw(['symbolic-ref', '--short', 'HEAD'])).trim();
}

async function hasRef(v, ref) {
  try {
    await v.git.raw(['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function conflictName(v, file) {
  const { dir, name, ext } = path.posix.parse(file);
  for (let n = 1; ; n++) {
    const candidate = path.posix.join(dir, `${name}.conflict-${localDate()}${n > 1 ? `-${n}` : ''}${ext}`);
    if (!fs.existsSync(path.join(v.dir, candidate))) return candidate;
  }
}

// Map of path -> { 1: baseSha, 2: sha, 3: sha } for every unmerged path.
async function unmergedPaths(v) {
  const map = new Map();
  for (const entry of (await v.git.raw(['ls-files', '-u', '-z'])).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [, sha, stage] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    map.set(file, { ...map.get(file), [stage]: sha });
  }
  return map;
}

// During a rebase, stage 2 ("ours") is the upstream side being built on and stage 3 ("theirs")
// is the local commit being replayed. So: stage 2 = incoming, stage 3 = mine.
async function keepMine(v, file, { 2: incoming, 3: mine }) {
  let saved = '(deleted upstream)';
  if (incoming) {
    saved = conflictName(v, file);
    const abs = path.join(v.dir, saved);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, await v.git.showBuffer([incoming]));
    await v.git.raw(['add', '-f', '--', saved]);
  }
  if (mine) {
    await v.git.raw(['checkout', '--theirs', '--', file]);
    await v.git.raw(['add', '-f', '--', file]);
  } else {
    await v.git.raw(['rm', '--quiet', '--force', '--', file]);
  }
  log(v, `CONFLICT ${file}: kept local version${mine ? '' : ' (deleted locally)'}, incoming saved as ${saved}`);
}

// Resolve every stop of an in-progress rebase. Local versions win on disk; incoming versions
// become conflict files. Anything unexpected aborts the rebase, which restores the local commits.
async function resolveRebase(v) {
  while (rebaseInProgress(v)) {
    const unmerged = await unmergedPaths(v);
    if (!unmerged.size) {
      await v.git.raw(['rebase', '--abort']);
      throw new Error('rebase stopped without a file conflict; aborted it, local commits are untouched');
    }
    for (const [file, stages] of unmerged) await keepMine(v, file, stages);
    // Committing ourselves avoids rebase --continue opening an editor for the message.
    await v.git.raw(['commit', '--no-edit', '--no-verify']);
    await v.git.raw(['rebase', '--continue']).catch(() => {}); // a later commit may stop it again
  }
}

// --- the three steps ---

export async function commitAll(v) {
  await v.git.raw(['add', '-A']);
  const files = (await v.git.raw(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  if (!files.length) return 0;
  await v.git.commit(`vault backup: ${os.hostname()} ${now()} (${files.length} file${files.length === 1 ? '' : 's'})`);
  log(v, `committed ${files.length} file(s)`);
  return files.length;
}

export async function pull(v) {
  const remote = `origin/${await branchName(v)}`;
  await v.git.fetch('origin');
  if ((await hasRef(v, remote)) && (await hasRef(v, 'HEAD')) && (await count(v, `HEAD..${remote}`)) > 0) {
    await v.git.raw(['rebase', '--autostash', remote]).catch((err) => {
      if (!rebaseInProgress(v)) throw err;
    });
    await resolveRebase(v);
    log(v, `pulled ${remote}`);
  }
  saveState(v, { lastPull: now() });
}

export async function push(v) {
  const branch = await branchName(v);
  if (!(await hasRef(v, 'HEAD'))) return;
  if ((await hasRef(v, `origin/${branch}`)) && (await count(v, `origin/${branch}..HEAD`)) === 0) return;
  await v.git.push(['-u', 'origin', branch]);
  saveState(v, { lastPush: now() });
  log(v, `pushed ${branch}`);
}

export async function sync(v) {
  try {
    if (rebaseInProgress(v)) await resolveRebase(v); // finish a run that died mid-conflict
    await commitAll(v);
    await pull(v);
    try {
      await push(v);
    } catch {
      await pull(v); // another device pushed in between; rebase onto it and try once more
      await push(v);
    }
    saveState(v, { lastError: null });
  } catch (err) {
    saveState(v, { lastError: `${now()} ${err.message.trim()}` });
    throw err;
  }
}

export async function status(v) {
  const state = readState(v);
  const branch = await branchName(v);
  const remote = `origin/${branch}`;
  const tracked = (await hasRef(v, 'HEAD')) && (await hasRef(v, remote));
  const listed = (await v.git.raw(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0');
  return {
    ...state,
    vault: v.dir,
    branch,
    ahead: tracked ? await count(v, `${remote}..HEAD`) : null,
    behind: tracked ? await count(v, `HEAD..${remote}`) : null,
    uncommitted: (await v.git.status()).files.length,
    stashes: (await v.git.raw(['stash', 'list'])).split('\n').filter(Boolean).length,
    rebaseInProgress: rebaseInProgress(v),
    conflicts: listed.filter((f) => CONFLICT_RE.test(f) && fs.existsSync(path.join(v.dir, f))),
  };
}

export async function init(v, templatePath) {
  if (!fs.existsSync(path.join(v.dir, '.git'))) await v.git.raw(['init', '-b', 'main']);
  // Notes must round-trip byte-for-byte between Windows, macOS and phones.
  await v.git.addConfig('core.autocrlf', 'false');
  await v.git.addConfig('core.quotepath', 'false');

  const ignorePath = path.join(v.dir, '.gitignore');
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = fs
    .readFileSync(templatePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#') && !have.has(l.trim()));
  if (missing.length) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(ignorePath, existing + sep + missing.join('\n') + '\n');
  }
  return missing;
}
