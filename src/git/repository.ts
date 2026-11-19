import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitCli, GitError } from './cli';
import {
  DETAILS_FORMAT,
  FILE_LOG_FORMAT,
  GitRef,
  LOG_FORMAT,
  REF_FORMAT,
  Submodule,
  Worktree,
  parseCommitDetails,
  parseFileLog,
  parseGitmodules,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStashes,
  parseSubmoduleStatus,
  parseWorktrees,
  STASH_FORMAT,
  Stash,
} from './parsers';
import type { CommitDetails, CommitFile, CommitRow, GitOperation } from '../shared/protocol';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface HeadInfo {
  /** Branch name when not detached. */
  branch?: string;
  commit?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface Remote {
  name: string;
  fetchUrl?: string;
  pushUrl?: string;
}

export interface LogQuery {
  revs: string[];
  skip?: number;
  maxCount?: number;
  firstParent?: boolean;
}

export class GitRepository {
  private gitDirCache?: string;

  constructor(readonly root: string, readonly git: GitCli = new GitCli()) {}

  get name(): string {
    return path.basename(this.root);
  }

  exec(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return this.git.exec(this.root, args, { env });
  }

  async gitDir(): Promise<string> {
    if (!this.gitDirCache) {
      this.gitDirCache = (await this.exec(['rev-parse', '--absolute-git-dir'])).trim();
    }
    return this.gitDirCache;
  }

  async tryRevParse(rev: string): Promise<string | undefined> {
    try {
      return (await this.exec(['rev-parse', '--verify', '--quiet', '--end-of-options', rev])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async getHead(): Promise<HeadInfo> {
    const commit = await this.tryRevParse('HEAD');
    let branch: string | undefined;
    try {
      branch = (await this.exec(['symbolic-ref', '-q', '--short', 'HEAD'])).trim() || undefined;
    } catch {
      branch = undefined;
    }
    const info: HeadInfo = { branch, commit, detached: !branch, ahead: 0, behind: 0 };
    if (branch) {
      info.upstream = await this.getUpstream(branch);
      if (info.upstream && commit) {
        const counts = await this.aheadBehind(branch, info.upstream);
        info.ahead = counts.ahead;
        info.behind = counts.behind;
      }
    }
    return info;
  }

  async getUpstream(branch: string): Promise<string | undefined> {
    try {
      return (await this.exec(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async aheadBehind(local: string, upstream: string): Promise<{ ahead: number; behind: number }> {
    try {
      const out = (await this.exec(['rev-list', '--left-right', '--count', `${local}...${upstream}`])).trim();
      const [ahead, behind] = out.split(/\s+/).map(Number);
      return { ahead: ahead || 0, behind: behind || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  async getRemotes(): Promise<Remote[]> {
    const out = await this.exec(['remote', '-v']);
    const map = new Map<string, Remote>();
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line.trim());
      if (!m) continue;
      const remote = map.get(m[1]) ?? { name: m[1] };
      if (m[3] === 'fetch') remote.fetchUrl = m[2];
      else remote.pushUrl = m[2];
      map.set(m[1], remote);
    }
    return [...map.values()];
  }

  async getRefs(): Promise<GitRef[]> {
    const [out, remotes] = await Promise.all([
      this.exec(['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.getRemotes(),
    ]);
    return parseRefs(out, remotes.map(r => r.name));
  }

  /** Cheap fingerprint of HEAD + all refs + stashes, used to decide whether views need reloading. */
  async signature(): Promise<string> {
    const [refs, head, op, stashes] = await Promise.all([
      this.exec(['for-each-ref', '--format=%(refname) %(objectname)']).catch(() => ''),
      this.exec(['rev-parse', 'HEAD']).catch(() => ''),
      this.getOperation(),
      // Dropping an older stash only rewrites the reflog, not refs/stash.
      this.exec(['stash', 'list', '--format=%H']).catch(() => ''),
    ]);
    const symbolic = await this.exec(['symbolic-ref', '-q', 'HEAD']).catch(() => '');
    return `${head}|${symbolic}|${op ?? ''}|${refs}|${stashes}`;
  }

  async log(query: LogQuery): Promise<CommitRow[]> {
    const args = ['log', `--format=${LOG_FORMAT}`, '--decorate=full', '--date-order'];
    if (query.firstParent) args.push('--first-parent');
    if (query.maxCount !== undefined) args.push(`--max-count=${query.maxCount}`);
    if (query.skip) args.push(`--skip=${query.skip}`);
    args.push(...query.revs, '--');
    try {
      return parseLog(await this.exec(args));
    } catch (e) {
      // Empty repositories have no HEAD yet.
      if (e instanceof GitError && /does not have any commits|unknown revision|bad default revision/.test(e.message)) {
        return [];
      }
      throw e;
    }
  }

  /**
   * Commits that changed `relPath`, newest first, following renames. There is no `skip`: git only
   * follows a rename while printing, so skipped commits would lose it. Page by raising `maxCount`.
   */
  async fileLog(relPath: string, maxCount?: number): Promise<CommitRow[]> {
    const file = relPath.replace(/\\/g, '/');
    const args = ['log', '--follow', `--format=${FILE_LOG_FORMAT}`, '--decorate=full', '--name-status', '-z'];
    if (maxCount !== undefined) args.push(`--max-count=${maxCount}`);
    args.push('HEAD', '--', file);
    try {
      return parseFileLog(await this.exec(args), file);
    } catch (e) {
      if (e instanceof GitError && /does not have any commits|unknown revision|bad default revision|ambiguous argument 'HEAD'/.test(e.message)) {
        return [];
      }
      throw e;
    }
  }

  /** Searches history for commits whose message, author or hash matches `text`. */
  async search(revs: string[], text: string, maxCount = 500, firstParent = false): Promise<CommitRow[]> {
    const base = ['log', `--format=${LOG_FORMAT}`, '--decorate=full', '--date-order', `--max-count=${maxCount}`, '-i', '-F'];
    if (firstParent) base.push('--first-parent');
    const queries = [
      [...base, `--grep=${text}`, ...revs, '--'],
      [...base, `--author=${text}`, ...revs, '--'],
    ];
    const results = await Promise.all(queries.map(q => this.exec(q).then(parseLog).catch(() => [] as CommitRow[])));
    const byHash = new Map<string, CommitRow>();
    for (const list of results) for (const c of list) byHash.set(c.hash, c);

    if (/^[0-9a-f]{4,64}$/i.test(text)) {
      const lower = text.toLowerCase();
      const hashes = await this.exec(['rev-list', `--max-count=20000`, ...revs, '--']).catch(() => '');
      const matches = hashes.split('\n').filter(h => h.startsWith(lower)).slice(0, 50);
      if (matches.length) {
        const rows = await this.exec(['log', `--format=${LOG_FORMAT}`, '--decorate=full', '--no-walk', ...matches, '--']).then(parseLog).catch(() => []);
        for (const c of rows) byHash.set(c.hash, c);
      }
    }
    return [...byHash.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, maxCount);
  }

  async revList(range: string, maxCount = 10000): Promise<string[]> {
    try {
      const out = await this.exec(['rev-list', `--max-count=${maxCount}`, range, '--']);
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  async getCommitDetails(hash: string): Promise<CommitDetails> {
    const raw = await this.exec(['show', '-s', '--decorate=full', `--format=${DETAILS_FORMAT}`, hash, '--']);
    const parentsField = raw.split('\0')[1];
    const parents = parentsField ? parentsField.split(' ') : [];
    const base = parents[0] ?? EMPTY_TREE;
    const files = parseNameStatus(await this.exec(['diff-tree', '-r', '-M', '-z', '--name-status', '--no-commit-id', base, hash]));
    return parseCommitDetails(raw, files);
  }

  async getCommitMessage(hash: string): Promise<string> {
    return (await this.exec(['log', '-1', '--format=%B', hash, '--'])).replace(/\s+$/, '');
  }

  /** Returns the content of `relPath` at `ref`, or an empty buffer if it does not exist there. */
  async show(ref: string, relPath: string): Promise<Buffer> {
    if (!ref || ref === EMPTY_TREE) return Buffer.alloc(0);
    try {
      return await this.git.exec(this.root, ['show', `${ref}:${relPath.replace(/\\/g, '/')}`], { raw: true });
    } catch {
      return Buffer.alloc(0);
    }
  }

  async getWorktrees(): Promise<Worktree[]> {
    try {
      return parseWorktrees(await this.exec(['worktree', 'list', '--porcelain']));
    } catch {
      return [];
    }
  }

  async getSubmodules(): Promise<Submodule[]> {
    if (!fs.existsSync(path.join(this.root, '.gitmodules'))) return [];
    const [status, config] = await Promise.all([
      this.exec(['submodule', 'status']).catch(() => ''),
      this.exec(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\.']).catch(() => ''),
    ]);
    const modules = parseSubmoduleStatus(status);
    const meta = parseGitmodules(config);
    for (const m of modules) {
      for (const [name, entry] of meta) {
        if (entry.path === m.path) {
          m.name = name;
          m.url = entry.url;
        }
      }
    }
    return modules;
  }

  async getStashes(): Promise<Stash[]> {
    try {
      return parseStashes(await this.exec(['stash', 'list', `--format=${STASH_FORMAT}`]));
    } catch {
      return [];
    }
  }

  /** Changes recorded in a stash; files from its untracked-files commit are flagged `untracked`. */
  async getStashFiles(stash: Stash): Promise<(CommitFile & { untracked?: boolean })[]> {
    const diff = (from: string, to: string) =>
      this.exec(['diff-tree', '-r', '-M', '-z', '--name-status', '--no-commit-id', from, to]).then(parseNameStatus);
    const [tracked, untracked] = await Promise.all([
      diff(stash.parents[0] ?? EMPTY_TREE, stash.hash),
      stash.parents[2] ? diff(EMPTY_TREE, stash.parents[2]) : Promise.resolve([]),
    ]);
    return [...tracked, ...untracked.map(f => ({ ...f, untracked: true }))];
  }

  /** Current `stash@{n}` selector for a stash commit, since indexes shift as stashes are added or dropped. */
  async stashRef(hash: string): Promise<string> {
    const stash = (await this.getStashes()).find(s => s.hash === hash);
    if (!stash) throw new Error('That stash no longer exists.');
    return stash.ref;
  }

  async getOperation(): Promise<GitOperation | undefined> {
    let dir: string;
    try {
      dir = await this.gitDir();
    } catch {
      return undefined;
    }
    const exists = (p: string) => fs.existsSync(path.join(dir, p));
    if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
    if (exists('MERGE_HEAD')) return 'merge';
    if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
    if (exists('REVERT_HEAD')) return 'revert';
    return undefined;
  }

  async isValidBranchName(name: string): Promise<boolean> {
    try {
      await this.exec(['check-ref-format', '--branch', name]);
      return true;
    } catch {
      return false;
    }
  }
}
