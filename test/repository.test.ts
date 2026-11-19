import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRepository } from '../src/git/repository';

const EMPTY_CONFIG = path.join(os.tmpdir(), 'gitrepo-test-empty.gitconfig');
fs.writeFileSync(EMPTY_CONFIG, '');

const ENV = {
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG,
  ...process.env,
  GIT_AUTHOR_NAME: 'Ada Lovelace',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada Lovelace',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args], { cwd, env: ENV, encoding: 'utf8' });
}

function commit(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}

let tmp: string;
let origin: string;
let work: string;
let repo: GitRepository;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitrepo-test-')));
  origin = path.join(tmp, 'origin.git');
  work = path.join(tmp, 'work');
  const sub = path.join(tmp, 'sub');
  fs.mkdirSync(sub);
  git(sub, 'init', '-q');
  commit(sub, 'lib.txt', 'lib', 'lib init');

  git(tmp, 'init', '-q', '--bare', origin);
  git(tmp, 'clone', '-q', origin, work);
  commit(work, 'a.txt', 'one\n', 'First commit');
  commit(work, 'b.txt', 'two\n', 'Second commit\n\nWith a body line.');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'tag', '-a', 'v1.0', '-m', 'release');

  git(work, 'checkout', '-q', '-b', 'feature/login');
  commit(work, 'c.txt', 'three\n', 'Feature work');
  git(work, 'checkout', '-q', 'main');
  commit(work, 'a.txt', 'one\nchanged\n', 'Main work');
  git(work, 'merge', '-q', '--no-ff', '-m', 'Merge feature/login', 'feature/login');
  git(work, 'mv', 'b.txt', 'renamed.txt');
  git(work, 'commit', '-q', '-m', 'Rename b');

  git(work, 'submodule', 'add', '-q', sub, 'libs/sub');
  git(work, 'commit', '-q', '-m', 'Add submodule');
  git(work, 'worktree', 'add', '-q', path.join(tmp, 'wt-feature'), 'feature/login');

  repo = new GitRepository(work);
  // Creating the fixture spawns ~30 git processes, which can exceed the 10s default on slow machines.
}, 60_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GitRepository', () => {
  it('reads HEAD with ahead/behind against upstream', async () => {
    const head = await repo.getHead();
    expect(head.branch).toBe('main');
    expect(head.upstream).toBe('origin/main');
    expect(head.ahead).toBe(5);
    expect(head.behind).toBe(0);
  });

  it('lists local, remote and tag refs', async () => {
    const refs = await repo.getRefs();
    const main = refs.find(r => r.fullName === 'refs/heads/main')!;
    expect(main).toMatchObject({ type: 'branch', isCurrent: true, upstream: 'origin/main', ahead: 5, behind: 0 });
    expect(refs.find(r => r.name === 'feature/login')).toMatchObject({ type: 'branch', isCurrent: false });
    expect(refs.find(r => r.type === 'remote')).toMatchObject({ name: 'origin/main', remote: 'origin' });
    const tag = refs.find(r => r.type === 'tag')!;
    expect(tag.name).toBe('v1.0');
    // Annotated tags resolve to the tagged commit.
    expect(tag.commit).toBe(git(work, 'rev-parse', 'v1.0^{commit}').trim());
  });

  it('logs commits with parents and full decorations', async () => {
    const commits = await repo.log({ revs: ['HEAD'] });
    expect(commits.map(c => c.subject)).toEqual([
      'Add submodule', 'Rename b', 'Merge feature/login', 'Main work', 'Feature work', 'Second commit', 'First commit',
    ]);
    expect(commits[0].refs).toContainEqual({ type: 'branch', name: 'main', fullName: 'refs/heads/main', isCurrent: true });
    expect(commits[2].parents).toHaveLength(2);
    expect(commits[4].refs.map(r => r.name)).toContain('feature/login');
    expect(commits[5].refs.map(r => r.name).sort()).toEqual(['origin/main', 'v1.0']);
    expect(commits[0].author).toBe('Ada Lovelace');
  });

  it('pages and follows first parent', async () => {
    const page = await repo.log({ revs: ['HEAD'], skip: 2, maxCount: 2 });
    expect(page.map(c => c.subject)).toEqual(['Merge feature/login', 'Main work']);
    const fp = await repo.log({ revs: ['HEAD'], firstParent: true });
    expect(fp.map(c => c.subject)).not.toContain('Feature work');
  });

  it('computes outgoing commits', async () => {
    expect(await repo.revList('origin/main..main')).toHaveLength(5);
    expect(await repo.revList('main..origin/main')).toHaveLength(0);
  });

  it('searches by message, author and hash', async () => {
    expect((await repo.search(['HEAD'], 'feature')).map(c => c.subject)).toEqual(['Merge feature/login', 'Feature work']);
    expect(await repo.search(['HEAD'], 'lovelace')).toHaveLength(7);
    const hash = git(work, 'rev-parse', 'HEAD~1').trim();
    expect((await repo.search(['HEAD'], hash.slice(0, 8))).map(c => c.subject)).toEqual(['Rename b']);
  });

  it('returns commit details with files, renames and body', async () => {
    const second = await repo.getCommitDetails(git(work, 'rev-parse', 'HEAD~4').trim());
    expect(second.subject).toBe('Second commit');
    expect(second.body).toBe('With a body line.');
    expect(second.files).toEqual([{ status: 'A', path: 'b.txt' }]);

    const rename = await repo.getCommitDetails(git(work, 'rev-parse', 'HEAD~1').trim());
    expect(rename.files).toEqual([{ status: 'R', path: 'renamed.txt', oldPath: 'b.txt' }]);

    const root = await repo.getCommitDetails(git(work, 'rev-list', '--max-parents=0', 'HEAD').trim());
    expect(root.parents).toEqual([]);
    expect(root.files).toEqual([{ status: 'A', path: 'a.txt' }]);
  });

  it('logs a file history across renames with the path at each commit', async () => {
    const rows = await repo.fileLog('renamed.txt');
    expect(rows.map(r => [r.subject, r.fileStatus, r.filePath, r.fileOldPath])).toEqual([
      ['Rename b', 'R', 'renamed.txt', 'b.txt'],
      ['Second commit', 'A', 'b.txt', undefined],
    ]);

    const a = await repo.fileLog('a.txt');
    expect(a.map(r => r.subject)).toEqual(['Main work', 'First commit']);
    expect((await repo.fileLog('a.txt', 1)).map(r => r.subject)).toEqual(['Main work']);
    expect(await repo.fileLog('missing.txt')).toEqual([]);
  });

  it('shows file content at a revision', async () => {
    expect((await repo.show('HEAD~3', 'a.txt')).toString()).toBe('one\nchanged\n');
    expect((await repo.show('HEAD', 'missing.txt')).length).toBe(0);
  });

  it('lists worktrees and submodules', async () => {
    const worktrees = await repo.getWorktrees();
    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toMatchObject({ isMain: true, branch: 'main' });
    expect(worktrees[1]).toMatchObject({ isMain: false, branch: 'feature/login', locked: false });

    const subs = await repo.getSubmodules();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ path: 'libs/sub', state: ' ', name: 'libs/sub' });
    expect(subs[0].url).toContain('sub');
  });

  it('detects in-progress operations', async () => {
    expect(await repo.getOperation()).toBeUndefined();
    git(work, 'checkout', '-q', '-b', 'conflict');
    commit(work, 'a.txt', 'conflict A\n', 'conflict A');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'a.txt', 'conflict B\n', 'conflict B');
    expect(() => git(work, 'merge', 'conflict')).toThrow();
    expect(await repo.getOperation()).toBe('merge');
    git(work, 'merge', '--abort');
    expect(await repo.getOperation()).toBeUndefined();
  });
});
