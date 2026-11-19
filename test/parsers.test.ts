import { describe, expect, it } from 'vitest';
import { parseCommitDetails, parseStashes, parseSubmoduleStatus, parseWorktrees } from '../src/git/parsers';

describe('parsers', () => {
  it('treats a wrapped first paragraph as the subject, not the body', () => {
    const raw = ['abc', 'p1', 'A', 'a@x', 'd', 'C', 'c@x', 'd', 'Wrapped subject line', '', 'Wrapped\nsubject line\n\nBody text\n'].join('\0');
    const details = parseCommitDetails(raw, []);
    expect(details.subject).toBe('Wrapped subject line');
    expect(details.body).toBe('Body text');
  });

  it('parses locked, detached and prunable worktrees', () => {
    const out = 'worktree C:/repo\nHEAD 111\nbranch refs/heads/main\n\nworktree C:/wt\nHEAD 222\ndetached\nlocked moving disks\nprunable gitdir file points to non-existent location\n\n';
    const [main, linked] = parseWorktrees(out);
    expect(main).toMatchObject({ isMain: true, branch: 'main' });
    expect(linked).toMatchObject({ isMain: false, detached: true, locked: true, lockReason: 'moving disks', prunable: true });
  });

  it('parses stash messages, branches and untracked-file parents', () => {
    const rec = (...f: string[]) => f.join('\0') + '\x1e';
    const out =
      rec('s0', 'b0 i0 u0', 'stash@{0}', 'On feature/x: my: message', '2026-11-19T08:00:00-05:00') +
      '\n' +
      rec('s1', 'b1 i1', 'stash@{1}', 'WIP on main: abc1234 Subject', '2026-11-18T08:00:00-05:00') +
      '\n' +
      rec('s2', 'b2 i2', 'stash@{2}', 'WIP on (no branch): abc1234 Subject', '2026-11-17T08:00:00-05:00');
    const [named, wip, detached] = parseStashes(out);
    expect(named).toMatchObject({ index: 0, ref: 'stash@{0}', hash: 's0', parents: ['b0', 'i0', 'u0'], branch: 'feature/x', message: 'my: message' });
    expect(wip).toMatchObject({ index: 1, branch: 'main', message: 'WIP on main: abc1234 Subject' });
    expect(detached.branch).toBeUndefined();
  });

  it('parses uninitialized and modified submodules', () => {
    const out = '-1234567890abcdef1234567890abcdef12345678 libs/not init\n+abcdefabcdefabcdefabcdefabcdefabcdefabcd libs/mod (v1.0-3-gabcdef)\n';
    expect(parseSubmoduleStatus(out)).toEqual([
      { state: '-', commit: '1234567890abcdef1234567890abcdef12345678', path: 'libs/not init', describe: undefined },
      { state: '+', commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd', path: 'libs/mod', describe: 'v1.0-3-gabcdef' },
    ]);
  });
});
