import type { CommitDetails, CommitFile, CommitRow, RefBadge } from '../shared/protocol';

export const FIELD = '\x00';
export const RECORD = '\x1e';

/** `git log --format` producing fields consumed by {@link parseLog}. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%D'].join('%x00') + '%x1e';

export interface GitRef {
  type: 'branch' | 'remote' | 'tag';
  name: string;
  fullName: string;
  commit: string;
  /** For remote branches the remote name, e.g. `origin`. */
  remote?: string;
  /** Short upstream name for local branches, e.g. `origin/main`. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  upstreamGone?: boolean;
  isCurrent: boolean;
  date?: string;
  subject?: string;
}

export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(creatordate:iso-strict)',
  '%(contents:subject)',
].join('%00');

export function parseRefs(output: string, remotes: readonly string[]): GitRef[] {
  const refs: GitRef[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [fullName, objectName, peeled, upstream, track, head, date, subject] = line.split(FIELD);
    const commit = peeled || objectName;
    if (fullName.startsWith('refs/heads/')) {
      const ref: GitRef = {
        type: 'branch',
        name: fullName.slice('refs/heads/'.length),
        fullName,
        commit,
        isCurrent: head === '*',
        date,
        subject,
      };
      if (upstream) {
        ref.upstream = upstream;
        ref.upstreamGone = track === 'gone';
        ref.ahead = Number(/ahead (\d+)/.exec(track ?? '')?.[1] ?? 0);
        ref.behind = Number(/behind (\d+)/.exec(track ?? '')?.[1] ?? 0);
      }
      refs.push(ref);
    } else if (fullName.startsWith('refs/remotes/')) {
      const name = fullName.slice('refs/remotes/'.length);
      if (name.endsWith('/HEAD')) continue;
      const remote = remotes.filter(r => name.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] ?? name.split('/')[0];
      refs.push({ type: 'remote', name, fullName, commit, remote, isCurrent: false, date, subject });
    } else if (fullName.startsWith('refs/tags/')) {
      refs.push({ type: 'tag', name: fullName.slice('refs/tags/'.length), fullName, commit, isCurrent: false, date, subject });
    }
  }
  return refs;
}

export function parseDecorations(decorations: string): RefBadge[] {
  const badges: RefBadge[] = [];
  if (!decorations) return badges;
  for (let item of decorations.split(', ')) {
    item = item.trim();
    if (!item) continue;
    let isCurrent = false;
    if (item.startsWith('HEAD -> ')) {
      isCurrent = true;
      item = item.slice('HEAD -> '.length);
    } else if (item === 'HEAD') {
      badges.push({ type: 'head', name: 'HEAD', fullName: 'HEAD', isCurrent: true });
      continue;
    }
    if (item.startsWith('tag: ')) item = item.slice('tag: '.length);
    if (item.startsWith('refs/heads/')) {
      badges.push({ type: 'branch', name: item.slice(11), fullName: item, isCurrent });
    } else if (item.startsWith('refs/remotes/')) {
      if (item.endsWith('/HEAD')) continue;
      badges.push({ type: 'remote', name: item.slice(13), fullName: item });
    } else if (item.startsWith('refs/tags/')) {
      badges.push({ type: 'tag', name: item.slice(10), fullName: item });
    }
  }
  return badges;
}

export function parseLog(output: string): CommitRow[] {
  const commits: CommitRow[] = [];
  for (let record of output.split(RECORD)) {
    record = record.replace(/^\s+/, '');
    if (!record) continue;
    const [hash, parents, author, authorEmail, date, subject, decorations] = record.split(FIELD);
    if (!hash) continue;
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      authorEmail,
      date,
      subject,
      refs: parseDecorations((decorations ?? '').trim()),
    });
  }
  return commits;
}

export const DETAILS_FORMAT = ['%H', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%D', '%B'].join('%x00');

export function parseCommitDetails(output: string, files: CommitFile[]): CommitDetails {
  const parts = output.split(FIELD);
  const [hash, parents, author, authorEmail, date, committer, committerEmail, committerDate, subject, decorations] = parts;
  const message = parts.slice(10).join(FIELD).replace(/\s+$/, '');
  // %s is the whole first paragraph joined onto one line, so the body starts after the first blank line.
  const paragraphBreak = message.search(/\r?\n\s*\r?\n/);
  const body = paragraphBreak < 0 ? '' : message.slice(paragraphBreak).replace(/^(\s*\r?\n)+/, '');
  return {
    hash: hash.trim(),
    parents: parents ? parents.split(' ') : [],
    author,
    authorEmail,
    date,
    committer,
    committerEmail,
    committerDate,
    subject,
    body,
    refs: parseDecorations(decorations.trim()),
    files,
  };
}

/** Parses `git diff-tree -z --name-status` output. */
export function parseNameStatus(output: string): CommitFile[] {
  const tokens = output.split('\0');
  const files: CommitFile[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      files.push({ status: code, path, oldPath });
    } else {
      files.push({ status: code, path: tokens[i++] });
    }
  }
  return files;
}

export interface Stash {
  index: number;
  /** Reflog selector, e.g. `stash@{0}`. Shifts whenever a newer stash is pushed or dropped. */
  ref: string;
  hash: string;
  /** `[base, index]`, plus the untracked-files commit when the stash includes untracked files. */
  parents: string[];
  /** The user's message, or git's default `WIP on <branch>: <hash> <subject>`. */
  message: string;
  branch?: string;
  date: string;
}

/** `git stash list --format` producing fields consumed by {@link parseStashes}. */
export const STASH_FORMAT = ['%H', '%P', '%gd', '%gs', '%aI'].join('%x00') + '%x1e';

export function parseStashes(output: string): Stash[] {
  const stashes: Stash[] = [];
  for (let record of output.split(RECORD)) {
    record = record.replace(/^\s+/, '');
    if (!record) continue;
    const [hash, parents, ref, subject = '', date] = record.split(FIELD);
    if (!hash || !ref) continue;
    // "WIP on main: abc123 subject" (default message) or "On main: user message".
    const m = /^(?:WIP on|On) ((?:\(no branch\))|[^:]+): ([\s\S]*)$/.exec(subject);
    const index = Number(/\{(\d+)\}/.exec(ref)?.[1] ?? stashes.length);
    stashes.push({
      index,
      ref,
      hash,
      parents: parents ? parents.split(' ') : [],
      message: m && subject.startsWith('On ') ? m[2] : subject,
      branch: m && m[1] !== '(no branch)' ? m[1] : undefined,
      date,
    });
  }
  return stashes;
}

export interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  isMain: boolean;
}

export function parseWorktrees(output: string): Worktree[] {
  const result: Worktree[] = [];
  const blocks = output.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length === 0) continue;
    const wt: Worktree = { path: '', detached: false, bare: false, locked: false, prunable: false, isMain: result.length === 0 };
    for (const line of lines) {
      const space = line.indexOf(' ');
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? '' : line.slice(space + 1);
      switch (key) {
        case 'worktree': wt.path = value; break;
        case 'HEAD': wt.head = value; break;
        case 'branch': wt.branch = value.replace(/^refs\/heads\//, ''); break;
        case 'detached': wt.detached = true; break;
        case 'bare': wt.bare = true; break;
        case 'locked': wt.locked = true; wt.lockReason = value || undefined; break;
        case 'prunable': wt.prunable = true; break;
      }
    }
    if (wt.path) result.push(wt);
  }
  return result;
}

export interface Submodule {
  path: string;
  commit: string;
  /** `-` not initialized, `+` checked-out commit differs from index, `U` merge conflict, ` ` up to date. */
  state: ' ' | '-' | '+' | 'U';
  describe?: string;
  url?: string;
  name?: string;
}

export function parseSubmoduleStatus(output: string): Submodule[] {
  const result: Submodule[] = [];
  for (const line of output.replace(/\r/g, '').split('\n')) {
    const m = /^([ +\-U])([0-9a-f]{7,64}) (.+?)(?: \((.*)\))?$/.exec(line);
    if (!m) continue;
    result.push({ state: m[1] as Submodule['state'], commit: m[2], path: m[3], describe: m[4] });
  }
  return result;
}

/** Parses `git config -f .gitmodules --get-regexp ^submodule\.` output into name -> {path,url}. */
export function parseGitmodules(output: string): Map<string, { path?: string; url?: string }> {
  const map = new Map<string, { path?: string; url?: string }>();
  for (const line of output.replace(/\r/g, '').split('\n')) {
    const m = /^submodule\.(.+)\.(path|url) (.*)$/.exec(line);
    if (!m) continue;
    const entry = map.get(m[1]) ?? {};
    entry[m[2] as 'path' | 'url'] = m[3];
    map.set(m[1], entry);
  }
  return map;
}
