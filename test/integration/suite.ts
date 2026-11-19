import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { RefTreeContext, RefTreeNode } from '../../src/shared/protocol';

const work = process.env.GITREPO_TEST_WORK!;
const tmpRoot = process.env.GITREPO_TEST_ROOT!;

const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
const commit = (file: string, content: string, message: string) => {
  fs.writeFileSync(path.join(work, file), content);
  git('add', '-A');
  git('commit', '-q', '-m', message);
};

// ---- prompt stubs -------------------------------------------------------------

const inputs: (string | undefined)[] = [];
const picks: ((items: any[]) => any)[] = [];
const errors: string[] = [];
const w = vscode.window as any;
w.showInputBox = async (options?: vscode.InputBoxOptions) => {
  if (inputs.length === 0) throw new Error(`Unexpected input box: ${options?.prompt}`);
  const value = inputs.shift();
  if (value !== undefined && options?.validateInput) {
    const problem = await options.validateInput(value);
    if (problem) throw new Error(`Input '${value}' rejected: ${typeof problem === 'string' ? problem : problem.message}`);
  }
  return value;
};
w.showQuickPick = async (items: any) => {
  const list = await items;
  const fn = picks.shift();
  if (!fn) throw new Error(`Unexpected quick pick: ${list.map((i: any) => i.label).join(', ')}`);
  return fn(list);
};
// Confirmations always accept the first (primary) action.
w.showWarningMessage = async (_message: string, ...rest: unknown[]) => rest.find(r => typeof r === 'string');
w.showInformationMessage = async () => undefined;
w.showErrorMessage = async (message: string) => {
  errors.push(message);
  return undefined;
};

// ---- helpers --------------------------------------------------------------------

// Git rewrites files with CRLF when core.autocrlf is enabled.
function readText(file: string): string {
  return fs.readFileSync(path.join(work, file), 'utf8').replace(/\r\n/g, '\n');
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, what: string, timeout = 30000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function exec(command: string, ...args: unknown[]): Promise<void> {
  const before = errors.length;
  await vscode.commands.executeCommand(`gitRepository.${command}`, ...args);
  assert.equal(errors.length, before, `${command} reported an error: ${errors.slice(before).join('\n')}`);
  assert.equal(inputs.length, 0, `${command} left unused inputs`);
  assert.equal(picks.length, 0, `${command} left unused picks`);
}

let api: ExtensionApi;

/** Freshly loaded branches-pane nodes. */
async function treeNodes(): Promise<RefTreeNode[]> {
  await api.refs.refresh();
  return api.refs.tree();
}

function findNode(nodes: RefTreeNode[], pred: (n: RefTreeNode) => boolean): RefTreeNode | undefined {
  for (const n of nodes) {
    if (pred(n)) return n;
    const child = n.children && findNode(n.children, pred);
    if (child) return child;
  }
  return undefined;
}

/** The context-menu argument VS Code passes for a node in the branches pane. */
async function paneContext(pred: (n: RefTreeNode) => boolean, what: string): Promise<RefTreeContext> {
  const node = findNode(await treeNodes(), pred);
  assert.ok(node, `${what} not found in the branches pane`);
  return { ...node.context, preventDefaultContextMenuItems: true } as RefTreeContext;
}

const refNode = (fullName: string) => paneContext(n => n.refFull === fullName, `ref ${fullName}`);
const stashNode = () => paneContext(n => n.context.treeItem === 'stash', 'stash');

const head = () => git('rev-parse', 'HEAD');
const branch = () => git('rev-parse', '--abbrev-ref', 'HEAD');

// ---- tests ----------------------------------------------------------------------

const tests: [string, () => Promise<void>][] = [
  ['discovers the workspace repository', async () => {
    const root = await waitFor(() => api.manager.current?.root, 'repository discovery');
    assert.equal(root.toLowerCase(), work.toLowerCase());
  }],

  ['shows grouped refs in the branches pane', async () => {
    const groups = await treeNodes();
    assert.deepEqual(groups.map(g => g.label), ['Branches', 'Remotes', 'Tags', 'Stashes', 'Worktrees', 'Submodules']);
    const branches = groups[0].children!;
    assert.equal(branches[0].label, 'main');
    assert.equal(branches[0].emphasis, true);
    assert.equal(branches[0].context.treeItem, 'ref:branch:current:upstream');
    assert.deepEqual(branches.map(b => b.label), ['main', 'staging', 'test', 'feature']);
    assert.equal(branches[3].children![0].label, 'one');
    assert.equal(groups[1].children![0].label, 'origin');
    assert.equal(groups[2].children![0].label, 'v1.0');
    assert.equal(groups[3].children![0].label, 'No stashes');
  }],

  ['resolves pane contexts to the objects they represent', async () => {
    const node = await api.refs.resolve(await refNode('refs/heads/feature/one'));
    assert.equal(node?.kind === 'ref' && node.ref.name, 'feature/one');
    const group = await api.refs.resolve(await paneContext(n => n.context.treeItem === 'group:tags', 'tags group'));
    assert.deepEqual(group, { kind: 'group', group: 'tags' });
    assert.equal(await api.refs.resolve({ webviewSection: 'tree', treeItem: 'ref:tag', refFull: 'refs/tags/missing' }), undefined);
  }],

  ['opens the history window', async () => {
    await exec('open');
    await waitFor(() => api.history.isVisible, 'history panel');
    await waitFor(() => api.history.readyCount > 0, 'webview script to load');
  }],

  ['creates and checks out a branch from a ref', async () => {
    inputs.push('topic');
    await exec('createBranchFrom', await refNode('refs/heads/main'));
    assert.equal(branch(), 'topic');
  }],

  ['checks out a local branch and merges with --no-ff', async () => {
    commit('topic.txt', 'topic\n', 'Topic commit');
    await exec('checkout', await refNode('refs/heads/main'));
    assert.equal(branch(), 'main');
    picks.push(items => items.find((i: any) => i.args.includes('--no-ff')));
    await exec('merge', await refNode('refs/heads/topic'));
    assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  }],

  ['creates an annotated tag at a commit from the history context menu', async () => {
    inputs.push('v2.0', 'Release 2');
    await exec('createTag', { webviewSection: 'commit', hash: head() });
    assert.equal(git('cat-file', '-t', 'v2.0'), 'tag');
  }],

  ['deletes a merged branch', async () => {
    await exec('deleteBranch', await refNode('refs/heads/topic'));
    assert.equal(git('branch', '--list', 'topic'), '');
  }],

  ['fetches through the Git extension and checks out a remote branch as a tracking branch', async () => {
    git('push', '-q', 'origin', 'main:remote-only');
    git('update-ref', '-d', 'refs/remotes/origin/remote-only');
    await exec('fetch');
    assert.ok(git('rev-parse', '--verify', 'refs/remotes/origin/remote-only'));
    await exec('checkout', await refNode('refs/remotes/origin/remote-only'));
    assert.equal(branch(), 'remote-only');
    assert.equal(git('rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/remote-only');
  }],

  ['pushes the current branch', async () => {
    commit('push.txt', 'push\n', 'Commit to push');
    await exec('push');
    assert.equal(git('ls-remote', 'origin', 'refs/heads/remote-only').split(/\s+/)[0], head());
  }],

  ['cherry-picks and reverts a commit', async () => {
    const feature = git('rev-parse', 'feature/one');
    await exec('cherryPick', { webviewSection: 'commit', hash: feature });
    assert.ok(fs.existsSync(path.join(work, 'c.txt')));
    await exec('revert', { webviewSection: 'commit', hash: head() });
    assert.ok(!fs.existsSync(path.join(work, 'c.txt')));
  }],

  ['amends the HEAD commit message', async () => {
    inputs.push('Amended subject');
    await exec('amendMessage', { webviewSection: 'commit', hash: head(), isHead: true });
    assert.equal(git('log', '-1', '--format=%s'), 'Amended subject');
  }],

  ['hard resets to an earlier commit', async () => {
    const target = git('rev-parse', 'HEAD~2');
    picks.push(items => items.find((i: any) => i.value === '--hard'));
    await exec('reset', { webviewSection: 'commit', hash: target });
    assert.equal(head(), target);
  }],

  ['opens a diff for a file in a commit', async () => {
    const hash = git('rev-parse', 'feature/one');
    await exec('openFileDiff', { webviewSection: 'file', hash, parentHash: git('rev-parse', 'feature/one~1'), filePath: 'c.txt', fileStatus: 'A' });
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'expected a diff editor');
    const right = await vscode.workspace.openTextDocument((tab.input as vscode.TabInputTextDiff).modified);
    assert.equal(right.getText(), 'three\n');
  }],

  ['detects a conflicting merge and aborts it', async () => {
    git('checkout', '-q', '-b', 'conflict');
    commit('a.txt', 'conflict theirs\n', 'Theirs');
    git('checkout', '-q', 'main');
    commit('a.txt', 'conflict ours\n', 'Ours');
    picks.push(items => items[0]);
    await vscode.commands.executeCommand('gitRepository.merge', await refNode('refs/heads/conflict'));
    assert.equal(await api.manager.current!.getOperation(), 'merge');
    await exec('abortOperation');
    assert.equal(await api.manager.current!.getOperation(), undefined);
  }],

  ['adds and removes a worktree', async () => {
    const target = path.join(tmpRoot, 'wt-feature');
    inputs.push(target);
    await exec('addWorktree', await refNode('refs/heads/feature/one'));
    let worktrees = await api.manager.current!.getWorktrees();
    assert.equal(worktrees.length, 2);
    assert.equal(worktrees[1].branch, 'feature/one');
    await exec('removeWorktree', await paneContext(n => n.context.worktreePath === worktrees[1].path, 'worktree'));
    worktrees = await api.manager.current!.getWorktrees();
    assert.equal(worktrees.length, 1);
  }],

  ['renames a branch', async () => {
    inputs.push('conflict-renamed');
    await exec('renameBranch', await refNode('refs/heads/conflict'));
    assert.equal(git('branch', '--list', 'conflict-renamed'), 'conflict-renamed');
  }],

  ['stashes all changes including untracked files and lists them in the tree', async () => {
    fs.writeFileSync(path.join(work, 'a.txt'), 'stashed edit\n');
    fs.writeFileSync(path.join(work, 'new.txt'), 'brand new\n');
    inputs.push('My stash');
    await exec('stashAll');
    assert.equal(git('status', '--porcelain'), '');
    const stash = findNode(await treeNodes(), n => n.context.treeItem === 'stash')!;
    assert.equal(stash.label, 'My stash');
    assert.match(String(stash.description), /^stash@\{0\} · on main/);
    assert.ok(stash.lazy);
    const files = await api.refs.stashFileNodes(stash.context.stashHash!);
    assert.deepEqual(files.map(f => [f.context.filePath, f.context.fileStatus, f.context.untracked]), [['a.txt', 'M', false], ['new.txt', 'A', true]]);
  }],

  ['opens the diff for a stashed untracked file', async () => {
    const files = await api.refs.stashFileNodes((await stashNode()).stashHash!);
    await exec('openStashFileDiff', files.find(f => f.context.untracked)!.context);
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'expected a diff editor');
    assert.equal(tab.label, 'new.txt (stash@{0}) [untracked]');
    const right = await vscode.workspace.openTextDocument((tab.input as vscode.TabInputTextDiff).modified);
    assert.equal(right.getText(), 'brand new\n');
  }],

  ['pops a stash', async () => {
    await exec('popStash', await stashNode());
    assert.equal(readText('new.txt'), 'brand new\n');
    assert.equal(git('stash', 'list'), '');
    git('reset', '-q', '--hard');
    git('clean', '-qfd');
  }],

  ['stashes while keeping staged changes, then deletes the stash', async () => {
    fs.writeFileSync(path.join(work, 'a.txt'), 'staged edit\n');
    git('add', 'a.txt');
    inputs.push('');
    await exec('stashKeepStaged');
    assert.equal(git('diff', '--cached', '--name-only'), 'a.txt');
    assert.equal(git('stash', 'list').split('\n').length, 1);
    await exec('dropStash', await stashNode());
    assert.equal(git('stash', 'list'), '');
    git('reset', '-q', '--hard');
  }],

  ['keeps the stash when popping it conflicts', async () => {
    fs.writeFileSync(path.join(work, 'a.txt'), 'stash side\n');
    inputs.push('Conflicting');
    await exec('stashAll');
    commit('a.txt', 'committed side\n', 'Change a.txt after stashing');
    await exec('popStash', await stashNode());
    assert.match(git('status', '--porcelain'), /^UU a\.txt/m);
    assert.equal(git('stash', 'list').split('\n').length, 1);
    git('reset', '-q', '--hard');
  }],

  ['creates a branch from a stash', async () => {
    inputs.push('from-stash');
    await exec('createBranchFromStash', await stashNode());
    assert.equal(branch(), 'from-stash');
    assert.equal(readText('a.txt'), 'stash side\n');
    assert.equal(git('stash', 'list'), '');
  }],

  ['views a file history across a rename and compares two selected versions', async () => {
    commit('history.txt', 'version 1\n', 'History v1');
    git('mv', 'history.txt', 'history-renamed.txt');
    git('commit', '-q', '-m', 'History rename');
    commit('history-renamed.txt', 'version 2\n', 'History v2');
    const root = api.manager.current!.root;
    await exec('viewFileHistory', vscode.Uri.file(path.join(root, 'history-renamed.txt')));
    const panel = await waitFor(() => api.fileHistory.find(root, 'history-renamed.txt'), 'file history panel');
    await waitFor(() => (panel.readyCount > 0 && panel.commits.length === 3) || undefined, 'file history rows');
    assert.deepEqual(
      panel.commits.map(c => [c.subject, c.filePath]),
      [['History v2', 'history-renamed.txt'], ['History rename', 'history-renamed.txt'], ['History v1', 'history.txt']],
    );

    const [newest, , oldest] = panel.commits;
    await exec('compareFileVersions', {
      webviewSection: 'fileCommit',
      repoRoot: root,
      selection: [newest, oldest].map(c => ({ hash: c.hash, filePath: c.filePath })),
    });
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'expected a diff editor');
    const input = tab.input as vscode.TabInputTextDiff;
    assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'version 1\n');
    assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), 'version 2\n');
    assert.match(tab.label, /history\.txt.*history-renamed\.txt/);
  }],
];

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<ExtensionApi>('michaelpaulus.git-repository-window');
  assert.ok(ext, 'extension not found');
  api = await ext.activate();
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
    } catch (e) {
      failed++;
      console.error(`  ✘ ${name}\n    ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }
  if (failed) throw new Error(`${failed} integration test(s) failed`);
}
