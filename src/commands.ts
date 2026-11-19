import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitError } from './git/cli';
import type { GitRef, Stash } from './git/parsers';
import type { GitRepository } from './git/repository';
import type { RepoManager } from './repoManager';
import { compareWithWorkingTree, openCommitFileDiff, openFileAtRevision, openStashFileDiff, stashFileRef } from './diff';
import type { HistoryPanel, HistoryTarget } from './views/historyPanel';
import type { RefsTreeProvider, TreeNode } from './views/refsTree';
import type { CommitFile, RefType } from './shared/protocol';

/** A ref passed to a command from either the tree view or a webview context menu. */
interface RefArg {
  type: Exclude<RefType, 'head'>;
  name: string;
  fullName: string;
  isCurrent: boolean;
  remote?: string;
  upstream?: string;
}

/** Shape of `data-vscode-context` objects set by the history webview. */
interface WebviewContext {
  webviewSection?: 'commit' | 'ref' | 'file';
  hash?: string;
  parentHash?: string;
  isHead?: boolean;
  isMerge?: boolean;
  subject?: string;
  refType?: Exclude<RefType, 'head'>;
  refName?: string;
  refFull?: string;
  isCurrentRef?: boolean;
  filePath?: string;
  fileOldPath?: string;
  fileStatus?: string;
}

type Arg = TreeNode | WebviewContext | undefined;

function asRef(arg: Arg): RefArg | undefined {
  if (!arg) return undefined;
  if ('kind' in arg && arg.kind === 'ref') {
    const r = arg.ref;
    return { type: r.type, name: r.name, fullName: r.fullName, isCurrent: r.isCurrent, remote: r.remote, upstream: r.upstream };
  }
  const ctx = arg as WebviewContext;
  if (ctx.webviewSection === 'ref' && ctx.refType && ctx.refName && ctx.refFull) {
    return { type: ctx.refType, name: ctx.refName, fullName: ctx.refFull, isCurrent: !!ctx.isCurrentRef };
  }
  return undefined;
}

function asCommit(arg: Arg): string | undefined {
  if (!arg || 'kind' in arg) return undefined;
  return (arg as WebviewContext).hash;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const isDirtyError = (e: unknown) =>
  e instanceof GitError && /would be overwritten|commit your changes or stash them|Your local changes/i.test(e.message);
const isConflictError = (e: unknown) => e instanceof GitError && /CONFLICT|conflict|after resolving the conflicts|could not apply/i.test(e.stdout + e.message);

export class Commands {
  constructor(
    private readonly manager: RepoManager,
    private readonly tree: RefsTreeProvider,
    private readonly history: HistoryPanel,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  register(): vscode.Disposable[] {
    const c = (id: string, fn: (arg?: Arg, ...rest: unknown[]) => unknown) =>
      vscode.commands.registerCommand(`gitRepository.${id}`, async (arg?: Arg, ...rest: unknown[]) => {
        try {
          await fn.call(this, arg, ...rest);
        } catch (e) {
          await this.showError(e);
        }
      });
    return [
      c('open', () => this.history.show()),
      c('refresh', () => this.refresh()),
      c('switchRepository', () => this.switchRepository()),
      c('fetch', () => this.fetch(false)),
      c('fetchPrune', () => this.fetch(true)),
      c('pull', () => this.pull()),
      c('push', () => this.push()),
      c('sync', () => this.sync()),
      c('filterTree', () => this.filterTree()),
      c('clearTreeFilter', () => this.tree.setFilter('')),
      c('showHistory', a => this.showHistory(a)),
      c('checkout', a => this.checkout(a)),
      c('createBranch', a => this.createBranch(a)),
      c('createBranchFrom', a => this.createBranch(a)),
      c('merge', a => this.merge(a)),
      c('rebase', a => this.rebase(a)),
      c('renameBranch', a => this.renameBranch(a)),
      c('deleteBranch', a => this.deleteBranch(a)),
      c('deleteRemoteBranch', a => this.deleteRemoteBranch(a)),
      c('pushBranch', a => this.pushBranch(a)),
      c('setUpstream', a => this.setUpstream(a)),
      c('unsetUpstream', a => this.unsetUpstream(a)),
      c('copyRefName', a => this.copyRefName(a)),
      c('deleteTag', a => this.deleteTag(a)),
      c('pushTag', a => this.pushTag(a)),
      c('deleteRemoteTag', a => this.deleteRemoteTag(a)),
      c('checkoutCommit', a => this.checkoutCommit(a)),
      c('createTag', a => this.createTag(a)),
      c('cherryPick', a => this.cherryPick(a)),
      c('revert', a => this.revert(a)),
      c('reset', a => this.reset(a)),
      c('amendMessage', a => this.amendMessage(a)),
      c('amendStaged', a => this.amendStaged(a)),
      c('copySha', a => this.copySha(a)),
      c('copyMessage', a => this.copyMessage(a)),
      c('openFileDiff', a => this.fileCommand(a, 'diff')),
      c('openFileAtRevision', a => this.fileCommand(a, 'revision')),
      c('compareWithWorkingTree', a => this.fileCommand(a, 'working')),
      c('openWorkingFile', a => this.fileCommand(a, 'open')),
      c('copyFilePath', a => this.fileCommand(a, 'copy')),
      c('abortOperation', () => this.abortOperation()),
      c('continueOperation', () => this.continueOperation()),
      c('stashAll', () => this.stashPush('all')),
      c('stashKeepStaged', () => this.stashPush('keepStaged')),
      c('stashStaged', () => this.stashPush('staged')),
      c('applyStash', a => this.applyStash(a, false)),
      c('popStash', a => this.applyStash(a, true)),
      c('dropStash', a => this.dropStash(a)),
      c('createBranchFromStash', a => this.createBranchFromStash(a)),
      c('clearStashes', () => this.clearStashes()),
      c('openStashFileDiff', a => this.stashFileCommand(a, 'diff')),
      c('compareStashFileWithWorkingTree', a => this.stashFileCommand(a, 'working')),
      c('openStashWorkingFile', a => this.stashFileCommand(a, 'open')),
      c('addWorktree', a => this.addWorktree(a)),
      c('openWorktree', a => this.openWorktree(a, true)),
      c('openWorktreeHere', a => this.openWorktree(a, false)),
      c('removeWorktree', a => this.removeWorktree(a)),
      c('lockWorktree', a => this.lockWorktree(a, true)),
      c('unlockWorktree', a => this.lockWorktree(a, false)),
      c('pruneWorktrees', () => this.pruneWorktrees()),
      c('addSubmodule', () => this.addSubmodule()),
      c('openSubmodule', a => this.openSubmodule(a)),
      c('updateSubmodule', a => this.submoduleCommand(a, 'update')),
      c('updateAllSubmodules', () => this.submoduleCommand(undefined, 'update')),
      c('syncSubmodule', a => this.submoduleCommand(a, 'sync')),
      c('deinitSubmodule', a => this.submoduleCommand(a, 'deinit')),
    ];
  }

  // ---------------------------------------------------------------- helpers

  private repo(): GitRepository {
    const repo = this.manager.current;
    if (!repo) throw new Error('No Git repository is open.');
    return repo;
  }

  /** Runs a mutating git operation with progress, then refreshes all views. */
  private async run<T>(title: string, task: (repo: GitRepository) => Promise<T>, notification = false): Promise<T> {
    const repo = this.repo();
    try {
      return await vscode.window.withProgress(
        { location: notification ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title },
        () => task(repo),
      );
    } finally {
      await this.manager.refresh(repo);
    }
  }

  private async showError(e: unknown): Promise<void> {
    this.output.error(errorMessage(e));
    if (isConflictError(e)) {
      const op = await this.manager.current?.getOperation();
      const actions = ['Open Source Control', ...(op ? ['Abort'] : [])];
      const choice = await vscode.window.showWarningMessage(
        `There are merge conflicts${op ? ` (${op} in progress)` : ''}. Resolve them in Source Control, then continue.`,
        ...actions,
      );
      if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
      if (choice === 'Abort') await vscode.commands.executeCommand('gitRepository.abortOperation');
      return;
    }
    const choice = await vscode.window.showErrorMessage(`Git: ${errorMessage(e)}`, 'Show Log');
    if (choice === 'Show Log') this.output.show();
  }

  private async confirm(message: string, detail: string | undefined, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  }

  private async currentBranch(repo: GitRepository): Promise<string | undefined> {
    return (await repo.getHead()).branch;
  }

  private async pickRef(
    repo: GitRepository,
    placeHolder: string,
    types: RefArg['type'][] = ['branch', 'remote', 'tag'],
  ): Promise<RefArg | undefined> {
    const refs = (await repo.getRefs()).filter(r => types.includes(r.type));
    const icon = (r: GitRef) => (r.type === 'tag' ? '$(tag)' : r.type === 'remote' ? '$(cloud)' : r.isCurrent ? '$(check)' : '$(git-branch)');
    const items = refs.map(r => ({
      label: `${icon(r)} ${r.name}`,
      description: r.commit.slice(0, 8),
      detail: r.subject,
      ref: r,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return picked && { type: picked.ref.type, name: picked.ref.name, fullName: picked.ref.fullName, isCurrent: picked.ref.isCurrent, remote: picked.ref.remote, upstream: picked.ref.upstream };
  }

  private async pickRemote(repo: GitRepository, placeHolder: string): Promise<string | undefined> {
    const remotes = await repo.getRemotes();
    if (remotes.length === 0) {
      void vscode.window.showWarningMessage('This repository has no remotes.');
      return undefined;
    }
    if (remotes.length === 1) return remotes[0].name;
    const picked = await vscode.window.showQuickPick(
      remotes.map(r => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl })),
      { placeHolder },
    );
    return picked?.label;
  }

  private async inputBranchName(repo: GitRepository, prompt: string, value?: string): Promise<string | undefined> {
    const existing = new Set((await repo.getRefs()).filter(r => r.type === 'branch').map(r => r.name));
    return vscode.window.showInputBox({
      prompt,
      value,
      valueSelection: value ? [value.lastIndexOf('/') + 1, value.length] : undefined,
      validateInput: async text => {
        const name = text.trim();
        if (!name) return 'Enter a branch name.';
        if (existing.has(name) && name !== value) return `A branch named '${name}' already exists.`;
        if (!(await repo.isValidBranchName(name))) return `'${name}' is not a valid branch name.`;
        return undefined;
      },
    }).then(v => v?.trim());
  }

  /** Runs a checkout, offering to stash or discard local changes when they block it. */
  private async checkoutWithRetry(repo: GitRepository, args: string[]): Promise<void> {
    try {
      await repo.exec(args);
    } catch (e) {
      if (!isDirtyError(e)) throw e;
      const stash = 'Stash and Checkout';
      const force = 'Discard Changes and Checkout';
      const choice = await vscode.window.showWarningMessage(
        'Your local changes would be overwritten by checkout.',
        { modal: true, detail: errorMessage(e) },
        stash,
        force,
      );
      if (choice === stash) {
        await repo.exec(['stash', 'push', '--include-untracked', '-m', 'Git Repository: auto-stash before checkout']);
        await repo.exec(args);
        try {
          await repo.exec(['stash', 'pop']);
        } catch (popError) {
          void vscode.window.showWarningMessage(`Checked out, but re-applying your stashed changes caused conflicts. The stash was kept. ${errorMessage(popError)}`);
        }
      } else if (choice === force) {
        await repo.exec([...args.slice(0, 1), '--force', ...args.slice(1)]);
      }
    }
  }

  // ---------------------------------------------------------------- general

  private async refresh(): Promise<void> {
    this.tree.refresh();
    await this.manager.refresh();
    await this.history.reload(true);
  }

  private async switchRepository(): Promise<void> {
    const repos = this.manager.list();
    if (repos.length === 0) {
      void vscode.window.showInformationMessage('No Git repositories found in this workspace.');
      return;
    }
    const current = this.manager.current;
    const picked = await vscode.window.showQuickPick(
      repos.map(r => ({ label: `${r === current ? '$(check)' : '$(repo)'} ${r.name}`, description: r.root, repo: r })),
      { placeHolder: 'Select the repository to show in the Git Repository window' },
    );
    if (picked) this.manager.setCurrent(picked.repo.root);
  }

  private async filterTree(): Promise<void> {
    const text = await vscode.window.showInputBox({
      prompt: 'Filter branches, tags, worktrees and submodules',
      value: this.tree.filter,
      placeHolder: 'e.g. feature/',
    });
    if (text !== undefined) this.tree.setFilter(text);
  }

  private async showHistory(arg: Arg): Promise<void> {
    let ref = asRef(arg);
    if (!ref && arg && (arg as { pick?: boolean }).pick) {
      ref = await this.pickRef(this.repo(), 'Select a branch or tag to view its history');
      if (!ref) return;
    }
    const target: HistoryTarget | null = ref ? { type: ref.type, name: ref.name, fullName: ref.fullName } : null;
    this.history.show(ref?.isCurrent ? null : target);
  }

  // ---------------------------------------------------------------- network

  private async fetch(prune: boolean): Promise<void> {
    await this.run(prune ? 'Fetching (prune)...' : 'Fetching...', async repo => {
      const api = this.manager.apiRepository(repo);
      if (api) await api.fetch({ all: true, prune });
      else await repo.exec(['fetch', '--all', ...(prune ? ['--prune'] : [])]);
    });
  }

  private async pull(): Promise<void> {
    await this.run('Pulling...', async repo => {
      const head = await repo.getHead();
      if (!head.upstream) throw new Error(`The branch '${head.branch ?? 'HEAD'}' has no upstream branch to pull from.`);
      const api = this.manager.apiRepository(repo);
      if (api) await api.pull();
      else await repo.exec(['pull']);
    }, true);
  }

  private async push(): Promise<void> {
    const repo = this.repo();
    const head = await repo.getHead();
    if (!head.branch) throw new Error('Cannot push a detached HEAD. Create a branch first.');
    await this.pushBranchByName(repo, head.branch, head.upstream);
  }

  private async pushBranchByName(repo: GitRepository, branch: string, upstream: string | undefined): Promise<void> {
    let remote: string | undefined;
    if (!upstream) {
      remote = await this.pickRemote(repo, `Select a remote to publish '${branch}' to`);
      if (!remote) return;
    }
    await this.run(upstream ? `Pushing ${branch}...` : `Publishing ${branch}...`, async r => {
      const api = this.manager.apiRepository(r);
      const isCurrent = (await this.currentBranch(r)) === branch;
      if (upstream) {
        const [upRemote, ...rest] = upstream.split('/');
        const upBranch = rest.join('/');
        if (api && isCurrent) await api.push();
        else if (api) await api.push(upRemote, `${branch}:${upBranch}`);
        else await r.exec(['push', upRemote, `refs/heads/${branch}:refs/heads/${upBranch}`]);
      } else if (api) {
        await api.push(remote, branch, true);
      } else {
        await r.exec(['push', '--set-upstream', remote!, `refs/heads/${branch}:refs/heads/${branch}`]);
      }
    }, true);
  }

  private async sync(): Promise<void> {
    const repo = this.repo();
    const head = await repo.getHead();
    if (!head.branch) throw new Error('Cannot sync a detached HEAD.');
    if (!head.upstream) {
      await this.pushBranchByName(repo, head.branch, undefined);
      return;
    }
    await this.pull();
    await this.push();
  }

  // ---------------------------------------------------------------- branches

  private async checkout(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg) ?? (await this.pickRef(repo, 'Select a branch or tag to check out'));
    if (!ref || ref.isCurrent) return;

    if (ref.type === 'branch') {
      await this.run(`Checking out ${ref.name}...`, r => this.checkoutWithRetry(r, ['checkout', ref.name, '--']));
    } else if (ref.type === 'tag') {
      await this.run(`Checking out ${ref.name}...`, r => this.checkoutWithRetry(r, ['checkout', '--detach', ref.fullName, '--']));
    } else {
      const refs = await repo.getRefs();
      const remote = ref.remote ?? (await repo.getRemotes()).map(r => r.name).find(r => ref.name.startsWith(r + '/')) ?? ref.name.split('/')[0];
      const localName = ref.name.slice(remote.length + 1);
      const existing = refs.find(r => r.type === 'branch' && r.name === localName);
      if (existing && existing.upstream === ref.name) {
        if (existing.isCurrent) return;
        await this.run(`Checking out ${localName}...`, r => this.checkoutWithRetry(r, ['checkout', localName, '--']));
        return;
      }
      let name = localName;
      if (existing) {
        const picked = await this.inputBranchName(repo, `A local branch '${localName}' already exists and tracks a different upstream. Enter a name for the new tracking branch`, `${localName}-${remote}`);
        if (!picked) return;
        name = picked;
      }
      await this.run(`Checking out ${ref.name}...`, r => this.checkoutWithRetry(r, ['checkout', '-b', name, '--track', ref.name]));
    }
  }

  private async createBranch(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg);
    const commit = asCommit(arg);
    let base: string;
    let baseLabel: string;
    let suggested = '';
    if (ref) {
      base = ref.fullName;
      baseLabel = ref.name;
      if (ref.type === 'remote') suggested = ref.name.slice((ref.remote ?? ref.name.split('/')[0]).length + 1);
    } else if (commit) {
      base = commit;
      baseLabel = commit.slice(0, 8);
    } else {
      const picked = await vscode.window.showQuickPick(
        [{ label: '$(git-commit) Current HEAD', ref: undefined as RefArg | undefined }, { label: '$(list-selection) Select a branch or tag...', ref: undefined }],
        { placeHolder: 'Create the new branch from' },
      );
      if (!picked) return;
      if (picked.label.includes('Select')) {
        const r = await this.pickRef(repo, 'Select the branch or tag to base the new branch on');
        if (!r) return;
        base = r.fullName;
        baseLabel = r.name;
        if (r.type === 'remote') suggested = r.name.slice((r.remote ?? r.name.split('/')[0]).length + 1);
      } else {
        base = 'HEAD';
        baseLabel = (await this.currentBranch(repo)) ?? 'HEAD';
      }
    }
    const name = await this.inputBranchName(repo, `New branch name (based on ${baseLabel})`, suggested || undefined);
    if (!name) return;
    const checkout = vscode.workspace.getConfiguration('gitRepository').get<boolean>('checkoutNewBranch', true);
    const track = ref?.type === 'remote' ? ['--track'] : ['--no-track'];
    await this.run(`Creating branch ${name}...`, async r => {
      if (checkout) await this.checkoutWithRetry(r, ['checkout', '-b', name, ...track, base]);
      else await r.exec(['branch', ...track, name, base]);
    });
  }

  private async targetLabel(arg: Arg, verb: string): Promise<{ rev: string; label: string } | undefined> {
    const ref = asRef(arg);
    if (ref) return { rev: ref.fullName, label: ref.name };
    const commit = asCommit(arg);
    if (commit) return { rev: commit, label: commit.slice(0, 8) };
    const picked = await this.pickRef(this.repo(), `Select the branch to ${verb}`);
    return picked && { rev: picked.fullName, label: picked.name };
  }

  private async merge(arg: Arg): Promise<void> {
    const repo = this.repo();
    const target = await this.targetLabel(arg, 'merge into the current branch');
    if (!target) return;
    const current = (await this.currentBranch(repo)) ?? 'HEAD';
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Merge', description: 'Fast-forward when possible', args: [] as string[] },
        { label: 'Merge (no fast-forward)', description: 'Always create a merge commit', args: ['--no-ff'] },
        { label: 'Squash Merge', description: 'Stage the combined changes without committing', args: ['--squash'] },
        { label: 'Fast-forward Only', description: 'Fail if a merge commit would be required', args: ['--ff-only'] },
      ],
      { placeHolder: `Merge '${target.label}' into '${current}'` },
    );
    if (!mode) return;
    await this.run(`Merging ${target.label} into ${current}...`, r => r.exec(['merge', '--no-edit', ...mode.args, target.rev]), true);
    if (mode.args.includes('--squash')) {
      void vscode.window.showInformationMessage(`Squashed changes from '${target.label}' are staged. Commit them from Source Control.`);
      await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

  private async rebase(arg: Arg): Promise<void> {
    const repo = this.repo();
    const target = await this.targetLabel(arg, 'rebase the current branch onto');
    if (!target) return;
    const current = (await this.currentBranch(repo)) ?? 'HEAD';
    if (!(await this.confirm(`Rebase '${current}' onto '${target.label}'?`, 'Commits on the current branch will be rewritten on top of the target.', 'Rebase'))) return;
    await this.run(`Rebasing ${current} onto ${target.label}...`, r => r.exec(['rebase', target.rev]), true);
  }

  private async renameBranch(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg) ?? (await this.pickRef(repo, 'Select the branch to rename', ['branch']));
    if (!ref || ref.type !== 'branch') return;
    const name = await this.inputBranchName(repo, `Rename branch '${ref.name}'`, ref.name);
    if (!name || name === ref.name) return;
    await this.run(`Renaming ${ref.name}...`, r => r.exec(['branch', '-m', ref.name, name]));
  }

  private async deleteBranch(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg) ?? (await this.pickRef(repo, 'Select the branch to delete', ['branch']));
    if (!ref || ref.type !== 'branch') return;
    if (ref.isCurrent) throw new Error('Cannot delete the branch that is currently checked out.');
    if (!(await this.confirm(`Delete branch '${ref.name}'?`, undefined, 'Delete'))) return;
    try {
      await this.run(`Deleting ${ref.name}...`, r => r.exec(['branch', '-d', ref.name]));
    } catch (e) {
      if (!(e instanceof GitError && /not fully merged/.test(e.message))) throw e;
      if (await this.confirm(`The branch '${ref.name}' is not fully merged. Delete it anyway?`, 'Unmerged commits will be lost unless they are reachable from another ref.', 'Force Delete')) {
        await this.run(`Deleting ${ref.name}...`, r => r.exec(['branch', '-D', ref.name]));
      }
    }
  }

  private async deleteRemoteBranch(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg) ?? (await this.pickRef(repo, 'Select the remote branch to delete', ['remote']));
    if (!ref || ref.type !== 'remote') return;
    const remote = ref.remote ?? (await repo.getRemotes()).map(r => r.name).find(r => ref.name.startsWith(r + '/')) ?? ref.name.split('/')[0];
    const branch = ref.name.slice(remote.length + 1);
    if (!(await this.confirm(`Delete '${branch}' from remote '${remote}'?`, 'This removes the branch on the server for everyone.', 'Delete'))) return;
    await this.run(`Deleting ${ref.name}...`, r => r.exec(['push', remote, '--delete', branch]), true);
  }

  private async pushBranch(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg);
    if (!ref) return this.push();
    if (ref.type !== 'branch') return;
    const upstream = ref.upstream ?? (await repo.getUpstream(ref.name));
    await this.pushBranchByName(repo, ref.name, upstream);
  }

  private async setUpstream(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg) ?? (await this.pickRef(repo, 'Select the local branch', ['branch']));
    if (!ref || ref.type !== 'branch') return;
    const upstream = await this.pickRef(repo, `Select the upstream branch for '${ref.name}'`, ['remote']);
    if (!upstream) return;
    await this.run('Setting upstream...', r => r.exec(['branch', `--set-upstream-to=${upstream.name}`, ref.name]));
  }

  private async unsetUpstream(arg: Arg): Promise<void> {
    const ref = asRef(arg);
    if (!ref || ref.type !== 'branch') return;
    await this.run('Unsetting upstream...', r => r.exec(['branch', '--unset-upstream', ref.name]));
  }

  private async copyRefName(arg: Arg): Promise<void> {
    const ref = asRef(arg);
    if (ref) await vscode.env.clipboard.writeText(ref.name);
  }

  // ---------------------------------------------------------------- tags

  private async deleteTag(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg) ?? (await this.pickRef(repo, 'Select the tag to delete', ['tag']));
    if (!ref || ref.type !== 'tag') return;
    if (!(await this.confirm(`Delete tag '${ref.name}'?`, 'The tag is deleted locally only.', 'Delete'))) return;
    await this.run(`Deleting tag ${ref.name}...`, r => r.exec(['tag', '-d', ref.name]));
  }

  private async pushTag(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg) ?? (await this.pickRef(repo, 'Select the tag to push', ['tag']));
    if (!ref || ref.type !== 'tag') return;
    const remote = await this.pickRemote(repo, `Push tag '${ref.name}' to`);
    if (!remote) return;
    await this.run(`Pushing tag ${ref.name}...`, r => r.exec(['push', remote, ref.fullName]), true);
  }

  private async deleteRemoteTag(arg: Arg): Promise<void> {
    const repo = this.repo();
    const ref = asRef(arg) ?? (await this.pickRef(repo, 'Select the tag to delete from the remote', ['tag']));
    if (!ref || ref.type !== 'tag') return;
    const remote = await this.pickRemote(repo, `Delete tag '${ref.name}' from`);
    if (!remote) return;
    if (!(await this.confirm(`Delete tag '${ref.name}' from '${remote}'?`, undefined, 'Delete'))) return;
    await this.run(`Deleting remote tag ${ref.name}...`, r => r.exec(['push', remote, '--delete', ref.fullName]), true);
  }

  // ---------------------------------------------------------------- commits

  private commitArg(arg: Arg): string {
    const hash = asCommit(arg) ?? this.history.selectedCommit;
    if (!hash) throw new Error('Select a commit in the Git Repository window first.');
    return hash;
  }

  private async checkoutCommit(arg: Arg): Promise<void> {
    const hash = this.commitArg(arg);
    await this.run(`Checking out ${hash.slice(0, 8)}...`, r => this.checkoutWithRetry(r, ['checkout', '--detach', hash, '--']));
    void vscode.window.showInformationMessage(`HEAD is now detached at ${hash.slice(0, 8)}. Create a branch to keep any new commits.`);
  }

  private async createTag(arg: Arg): Promise<void> {
    const repo = this.repo();
    const hash = this.commitArg(arg);
    const existing = new Set((await repo.getRefs()).filter(r => r.type === 'tag').map(r => r.name));
    const name = (await vscode.window.showInputBox({
      prompt: `New tag name (at ${hash.slice(0, 8)})`,
      validateInput: async t => {
        const n = t.trim();
        if (!n) return 'Enter a tag name.';
        if (existing.has(n)) return `A tag named '${n}' already exists.`;
        try {
          await repo.exec(['check-ref-format', `refs/tags/${n}`]);
          return undefined;
        } catch {
          return `'${n}' is not a valid tag name.`;
        }
      },
    }))?.trim();
    if (!name) return;
    const message = await vscode.window.showInputBox({ prompt: 'Tag message (leave empty to create a lightweight tag)' });
    if (message === undefined) return;
    await this.run(`Creating tag ${name}...`, r => r.exec(message.trim() ? ['tag', '-a', name, '-m', message, hash] : ['tag', name, hash]));
  }

  private async cherryPick(arg: Arg): Promise<void> {
    const repo = this.repo();
    const hash = this.commitArg(arg);
    const parents = (await repo.getCommitDetails(hash)).parents;
    const args = ['cherry-pick', ...(parents.length > 1 ? ['-m', '1'] : []), hash];
    if (parents.length > 1 && !(await this.confirm(`'${hash.slice(0, 8)}' is a merge commit. Cherry-pick its changes relative to the first parent?`, undefined, 'Cherry-Pick'))) return;
    await this.run(`Cherry-picking ${hash.slice(0, 8)}...`, r => r.exec(args), true);
  }

  private async revert(arg: Arg): Promise<void> {
    const repo = this.repo();
    const hash = this.commitArg(arg);
    const parents = (await repo.getCommitDetails(hash)).parents;
    if (!(await this.confirm(`Revert commit '${hash.slice(0, 8)}'?`, parents.length > 1 ? 'This is a merge commit; it will be reverted relative to its first parent.' : 'A new commit undoing its changes will be created.', 'Revert'))) return;
    await this.run(`Reverting ${hash.slice(0, 8)}...`, r => r.exec(['revert', '--no-edit', ...(parents.length > 1 ? ['-m', '1'] : []), hash]), true);
  }

  private async reset(arg: Arg): Promise<void> {
    const repo = this.repo();
    const hash = this.commitArg(arg);
    const current = (await this.currentBranch(repo)) ?? 'HEAD';
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Mixed', description: 'Keep changes in the working tree, unstage them (--mixed)', value: '--mixed' },
        { label: 'Soft', description: 'Keep changes staged (--soft)', value: '--soft' },
        { label: 'Hard', description: 'Discard all changes (--hard)', value: '--hard' },
      ],
      { placeHolder: `Reset '${current}' to ${hash.slice(0, 8)}` },
    );
    if (!mode) return;
    if (mode.value === '--hard' && !(await this.confirm(`Hard reset '${current}' to ${hash.slice(0, 8)}?`, 'All uncommitted changes and commits after this one will be discarded.', 'Reset'))) return;
    await this.run(`Resetting to ${hash.slice(0, 8)}...`, r => r.exec(['reset', mode.value, hash]));
  }

  private async amendMessage(arg: Arg): Promise<void> {
    const repo = this.repo();
    const hash = this.commitArg(arg);
    const head = await repo.tryRevParse('HEAD');
    if (head !== hash) throw new Error('Only the most recent commit (HEAD) can be amended.');
    const message = await repo.getCommitMessage(hash);
    const [subject, ...rest] = message.split('\n');
    const newSubject = await vscode.window.showInputBox({ prompt: 'Amend commit message', value: subject, validateInput: t => (t.trim() ? undefined : 'The message cannot be empty.') });
    if (!newSubject || newSubject === subject) return;
    const full = [newSubject, ...rest].join('\n');
    await this.run('Amending commit...', r => r.exec(['commit', '--amend', '--only', '-m', full]));
  }

  private async amendStaged(arg: Arg): Promise<void> {
    const repo = this.repo();
    const hash = this.commitArg(arg);
    if ((await repo.tryRevParse('HEAD')) !== hash) throw new Error('Only the most recent commit (HEAD) can be amended.');
    const staged = (await repo.exec(['diff', '--cached', '--name-only'])).trim();
    if (!staged) {
      void vscode.window.showInformationMessage('There are no staged changes to add to the commit.');
      return;
    }
    if (!(await this.confirm('Amend the last commit with the staged changes?', staged.split('\n').slice(0, 15).join('\n'), 'Amend'))) return;
    await this.run('Amending commit...', r => r.exec(['commit', '--amend', '--no-edit']));
  }

  private async copySha(arg: Arg): Promise<void> {
    await vscode.env.clipboard.writeText(this.commitArg(arg));
  }

  private async copyMessage(arg: Arg): Promise<void> {
    await vscode.env.clipboard.writeText(await this.repo().getCommitMessage(this.commitArg(arg)));
  }

  private async fileCommand(arg: Arg, action: 'diff' | 'revision' | 'working' | 'open' | 'copy'): Promise<void> {
    const ctx = arg as WebviewContext | undefined;
    if (!ctx?.filePath || !ctx.hash) return;
    const repo = this.repo();
    const file: CommitFile = { status: ctx.fileStatus ?? 'M', path: ctx.filePath, oldPath: ctx.fileOldPath || undefined };
    switch (action) {
      case 'diff':
        return openCommitFileDiff(repo, ctx.hash, ctx.parentHash || undefined, file);
      case 'revision':
        return openFileAtRevision(repo, ctx.hash, file.path);
      case 'working':
        return compareWithWorkingTree(repo, ctx.hash, file.path);
      case 'open':
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, file.path)));
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(file.path);
        return;
    }
  }

  // ---------------------------------------------------------------- operations in progress

  private async abortOperation(): Promise<void> {
    const op = await this.repo().getOperation();
    if (!op) {
      void vscode.window.showInformationMessage('No merge, rebase, cherry-pick or revert is in progress.');
      return;
    }
    if (!(await this.confirm(`Abort the ${op} in progress?`, 'The repository will return to its state before the operation started.', 'Abort'))) return;
    await this.run(`Aborting ${op}...`, r => r.exec([op, '--abort']));
  }

  private async continueOperation(): Promise<void> {
    const op = await this.repo().getOperation();
    if (!op) return;
    const args = op === 'merge' ? ['commit', '--no-edit'] : [op, '--continue'];
    await this.run(`Continuing ${op}...`, r => r.exec(args), true);
  }

  // ---------------------------------------------------------------- stashes

  private async stashPush(mode: 'all' | 'keepStaged' | 'staged'): Promise<void> {
    const prompts = {
      all: 'Stash all changes, including untracked files',
      keepStaged: 'Stash all changes, including untracked files, and keep staged changes in the working tree',
      staged: 'Stash only staged changes',
    };
    const message = await vscode.window.showInputBox({ prompt: prompts[mode], placeHolder: 'Stash message (optional)' });
    if (message === undefined) return;
    const args = ['stash', 'push'];
    if (mode === 'staged') args.push('--staged');
    else args.push('--include-untracked');
    if (mode === 'keepStaged') args.push('--keep-index');
    if (message.trim()) args.push('-m', message.trim());
    const out = await this.run('Stashing changes...', r => r.exec(args));
    if (/No local changes to save/i.test(out)) void vscode.window.showInformationMessage('There are no local changes to stash.');
  }

  /** Resolves the stash a command applies to, asking the user when it was run from the Command Palette. */
  private async stashArg(arg: Arg, placeHolder: string): Promise<Stash | undefined> {
    if (arg && 'kind' in arg && (arg.kind === 'stash' || arg.kind === 'stashFile')) return arg.stash;
    const stashes = await this.repo().getStashes();
    if (stashes.length === 0) {
      void vscode.window.showInformationMessage('There are no stashes.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      stashes.map(s => ({ label: `$(git-stash) ${s.message || '(no message)'}`, description: [s.ref, s.branch && `on ${s.branch}`].filter(Boolean).join(' · '), stash: s })),
      { placeHolder, matchOnDescription: true },
    );
    return picked?.stash;
  }

  private async applyStash(arg: Arg, pop: boolean): Promise<void> {
    const stash = await this.stashArg(arg, pop ? 'Select a stash to pop' : 'Select a stash to apply');
    if (!stash) return;
    const repo = this.repo();
    const ref = await repo.stashRef(stash.hash);
    try {
      await this.run(`${pop ? 'Popping' : 'Applying'} ${ref}...`, r => r.exec(['stash', pop ? 'pop' : 'apply', ref]));
    } catch (e) {
      if (!isConflictError(e)) throw e;
      const choice = await vscode.window.showWarningMessage(
        `Applying ${ref} caused conflicts.${pop ? ' The stash was kept so you can apply it again or drop it once the conflicts are resolved.' : ''} Resolve them in Source Control.`,
        'Open Source Control',
      );
      if (choice) await vscode.commands.executeCommand('workbench.view.scm');
    }
  }

  private async dropStash(arg: Arg): Promise<void> {
    const stash = await this.stashArg(arg, 'Select a stash to delete');
    if (!stash) return;
    const repo = this.repo();
    const ref = await repo.stashRef(stash.hash);
    if (!(await this.confirm(`Delete ${ref}?`, `"${stash.message}"\n\nThe stashed changes will be lost.`, 'Delete'))) return;
    await this.run(`Deleting ${ref}...`, r => r.exec(['stash', 'drop', ref]));
  }

  private async clearStashes(): Promise<void> {
    const count = (await this.repo().getStashes()).length;
    if (count === 0) return;
    if (!(await this.confirm(`Delete all ${count} stash${count === 1 ? '' : 'es'}?`, 'All stashed changes will be lost.', 'Delete All'))) return;
    await this.run('Deleting all stashes...', r => r.exec(['stash', 'clear']));
  }

  private async createBranchFromStash(arg: Arg): Promise<void> {
    const stash = await this.stashArg(arg, 'Select a stash to create a branch from');
    if (!stash) return;
    const repo = this.repo();
    const name = await this.inputBranchName(repo, 'Name of the new branch. It starts at the commit the stash was made on, with the stash applied.');
    if (!name) return;
    const ref = await repo.stashRef(stash.hash);
    await this.run(`Creating branch ${name} from ${ref}...`, r => r.exec(['stash', 'branch', name, ref]));
  }

  private async stashFileCommand(arg: Arg, action: 'diff' | 'working' | 'open'): Promise<void> {
    if (!arg || !('kind' in arg) || arg.kind !== 'stashFile') return;
    const repo = this.repo();
    switch (action) {
      case 'diff':
        return openStashFileDiff(repo, arg.stash, arg.file);
      case 'working':
        return compareWithWorkingTree(repo, stashFileRef(arg.stash, arg.file), arg.file.path);
      case 'open':
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo.root, arg.file.path)));
        return;
    }
  }

  // ---------------------------------------------------------------- worktrees

  private worktreePath(arg: Arg): string | undefined {
    return arg && 'kind' in arg && arg.kind === 'worktree' ? arg.worktree.path : undefined;
  }

  private async addWorktree(arg: Arg): Promise<void> {
    const repo = this.repo();
    let ref = asRef(arg);
    let newBranch: string | undefined;
    if (!ref) {
      const branches = (await repo.getRefs()).filter(r => r.type === 'branch' && !r.isCurrent);
      const used = new Set((await repo.getWorktrees()).map(w => w.branch).filter(Boolean));
      const picked = await vscode.window.showQuickPick(
        [
          { label: '$(add) Create New Branch...', ref: undefined as GitRef | undefined },
          ...branches.filter(b => !used.has(b.name)).map(b => ({ label: `$(git-branch) ${b.name}`, description: b.commit.slice(0, 8), ref: b as GitRef | undefined })),
        ],
        { placeHolder: 'Select a branch to check out in the new worktree' },
      );
      if (!picked) return;
      if (picked.ref) {
        ref = { type: 'branch', name: picked.ref.name, fullName: picked.ref.fullName, isCurrent: false };
      } else {
        newBranch = await this.inputBranchName(repo, 'Name of the new branch (created from HEAD)');
        if (!newBranch) return;
      }
    }

    const label = newBranch ?? ref!.name;
    const defaultPath = path.join(path.dirname(repo.root), `${repo.name}-${label.replace(/[\\/:*?"<>|]+/g, '-')}`);
    const target = await vscode.window.showInputBox({ prompt: 'Folder for the new worktree', value: defaultPath, valueSelection: [defaultPath.length, defaultPath.length] });
    if (!target) return;

    let args: string[];
    if (newBranch) {
      args = ['worktree', 'add', '-b', newBranch, target, 'HEAD'];
    } else if (ref!.type === 'branch') {
      args = ['worktree', 'add', target, ref!.name];
    } else if (ref!.type === 'remote') {
      const remote = ref!.remote ?? ref!.name.split('/')[0];
      const local = ref!.name.slice(remote.length + 1);
      const exists = (await repo.getRefs()).some(r => r.type === 'branch' && r.name === local);
      args = exists ? ['worktree', 'add', target, local] : ['worktree', 'add', '--track', '-b', local, target, ref!.name];
    } else {
      args = ['worktree', 'add', '--detach', target, ref!.fullName];
    }
    await this.run('Creating worktree...', r => r.exec(args), true);
    const open = await vscode.window.showInformationMessage(`Worktree created at ${target}.`, 'Open in New Window', 'Open in Current Window');
    if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: open === 'Open in New Window' });
  }

  private async openWorktree(arg: Arg, newWindow: boolean): Promise<void> {
    const p = this.worktreePath(arg);
    if (p) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p), { forceNewWindow: newWindow });
  }

  private async removeWorktree(arg: Arg): Promise<void> {
    const p = this.worktreePath(arg);
    if (!p) return;
    if (!(await this.confirm(`Remove worktree '${p}'?`, 'The worktree folder will be deleted. The branch is kept.', 'Remove'))) return;
    try {
      await this.run('Removing worktree...', r => r.exec(['worktree', 'remove', p]));
    } catch (e) {
      if (!(e instanceof GitError && /modified or untracked|is locked|--force/.test(e.message))) throw e;
      if (await this.confirm('The worktree has local changes or is locked. Remove it anyway?', e.message, 'Force Remove')) {
        await this.run('Removing worktree...', r => r.exec(['worktree', 'remove', '--force', '--force', p]));
      }
    }
  }

  private async lockWorktree(arg: Arg, lock: boolean): Promise<void> {
    const p = this.worktreePath(arg);
    if (!p) return;
    if (lock) {
      const reason = await vscode.window.showInputBox({ prompt: 'Lock reason (optional)' });
      if (reason === undefined) return;
      await this.run('Locking worktree...', r => r.exec(['worktree', 'lock', ...(reason ? ['--reason', reason] : []), p]));
    } else {
      await this.run('Unlocking worktree...', r => r.exec(['worktree', 'unlock', p]));
    }
  }

  private async pruneWorktrees(): Promise<void> {
    await this.run('Pruning worktrees...', r => r.exec(['worktree', 'prune']));
  }

  // ---------------------------------------------------------------- submodules

  private submodulePath(arg: Arg): string | undefined {
    return arg && 'kind' in arg && arg.kind === 'submodule' ? arg.submodule.path : undefined;
  }

  private async addSubmodule(): Promise<void> {
    const url = (await vscode.window.showInputBox({ prompt: 'Repository URL of the submodule', placeHolder: 'https://github.com/org/repo.git', validateInput: t => (t.trim() ? undefined : 'Enter a URL.') }))?.trim();
    if (!url) return;
    const name = path.basename(url).replace(/\.git$/, '');
    const target = (await vscode.window.showInputBox({ prompt: 'Path for the submodule (relative to the repository root)', value: name }))?.trim();
    if (!target) return;
    await this.run(`Adding submodule ${target}...`, r => r.exec(['submodule', 'add', '--', url, target]), true);
  }

  private async openSubmodule(arg: Arg): Promise<void> {
    const p = this.submodulePath(arg);
    if (p) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path.join(this.repo().root, p)), { forceNewWindow: true });
  }

  private async submoduleCommand(arg: Arg, action: 'update' | 'sync' | 'deinit'): Promise<void> {
    const p = this.submodulePath(arg);
    const scope = p ? ['--', p] : [];
    switch (action) {
      case 'update':
        await this.run(p ? `Updating ${p}...` : 'Updating submodules...', r => r.exec(['submodule', 'update', '--init', '--recursive', ...scope]), true);
        break;
      case 'sync':
        await this.run('Syncing submodule URL...', r => r.exec(['submodule', 'sync', '--recursive', ...scope]));
        break;
      case 'deinit': {
        if (!p || !(await this.confirm(`Deinitialize submodule '${p}'?`, 'Its working tree will be removed; it can be restored with Update.', 'Deinitialize'))) return;
        try {
          await this.run(`Deinitializing ${p}...`, r => r.exec(['submodule', 'deinit', ...scope]));
        } catch (e) {
          if (!(e instanceof GitError && /local modifications|use '-f'/.test(e.message))) throw e;
          if (await this.confirm(`'${p}' has local modifications. Deinitialize anyway?`, 'Local changes in the submodule will be lost.', 'Force')) {
            await this.run(`Deinitializing ${p}...`, r => r.exec(['submodule', 'deinit', '--force', ...scope]));
          }
        }
        break;
      }
    }
  }
}
