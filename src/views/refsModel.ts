import * as vscode from 'vscode';
import type { GitRef, Stash, Submodule, Worktree } from '../git/parsers';
import type { HeadInfo, Remote } from '../git/repository';
import type { RepoManager } from '../repoManager';
import type { CommitFile, RefTreeAction, RefTreeContext, RefTreeNode } from '../shared/protocol';

export type GroupKind = 'branches' | 'remotes' | 'tags' | 'stashes' | 'worktrees' | 'submodules';

export type StashFile = CommitFile & { untracked?: boolean };

/** Objects the commands operate on, resolved from a branches-pane `RefTreeContext`. */
export type TreeNode =
  | { kind: 'group'; group: GroupKind }
  | { kind: 'ref'; ref: GitRef; worktreePath?: string }
  | { kind: 'stash'; stash: Stash }
  | { kind: 'stashFile'; stash: Stash; file: StashFile }
  | { kind: 'worktree'; worktree: Worktree }
  | { kind: 'submodule'; submodule: Submodule };

export interface Snapshot {
  root: string;
  head: HeadInfo;
  refs: GitRef[];
  remotes: Remote[];
  stashes: Stash[];
  worktrees: Worktree[];
  submodules: Submodule[];
}

const GROUPS: { kind: GroupKind; label: string; icon: string; expanded: boolean }[] = [
  { kind: 'branches', label: 'Branches', icon: 'git-branch', expanded: true },
  { kind: 'remotes', label: 'Remotes', icon: 'cloud', expanded: true },
  { kind: 'tags', label: 'Tags', icon: 'tag', expanded: false },
  { kind: 'stashes', label: 'Stashes', icon: 'git-stash', expanded: false },
  { kind: 'worktrees', label: 'Worktrees', icon: 'worktree', expanded: false },
  { kind: 'submodules', label: 'Submodules', icon: 'file-submodule', expanded: false },
];

const STATUS_LABELS: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };

const action = (command: string, icon: string, title: string): RefTreeAction => ({ command: `gitRepository.${command}`, icon, title });

const GROUP_ACTIONS: Partial<Record<GroupKind, RefTreeAction[]>> = {
  branches: [action('createBranch', 'git-branch-create', 'New Branch...')],
  stashes: [action('stashAll', 'git-stash', 'Stash All...')],
  worktrees: [action('addWorktree', 'add', 'New Worktree...')],
  submodules: [action('addSubmodule', 'add', 'Add Submodule...')],
};

/**
 * Loads branches, remotes, tags, stashes, worktrees and submodules for the current repository and
 * shapes them into the tree shown in the Git Repository window's branches pane.
 */
export class RefsModel implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private current?: Snapshot;
  private token = 0;
  private pending?: Promise<Snapshot | undefined>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: RepoManager) {
    this.disposables.push(
      manager.onDidChangeCurrent(() => void this.refresh()),
      manager.onDidChangeRepository(repo => {
        if (repo === manager.current) void this.refresh();
      }),
      manager.onDidChangeRepositories(() => void this.refresh()),
    );
  }

  get snapshot(): Snapshot | undefined {
    return this.current;
  }

  /** Reloads the snapshot and notifies listeners. Concurrent calls share the latest load. */
  refresh(): Promise<Snapshot | undefined> {
    const token = ++this.token;
    const load = this.load()
      .catch(e => {
        void vscode.window.showErrorMessage(`Git Repository: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      })
      .then(snapshot => {
        if (token !== this.token) return this.pending!;
        this.current = snapshot;
        this._onDidChange.fire();
        return snapshot;
      });
    this.pending = load;
    return load;
  }

  /** Returns the snapshot, loading it if none is available yet. */
  async ensure(): Promise<Snapshot | undefined> {
    const root = this.manager.current?.root;
    if (this.current && this.current.root === root) return this.current;
    if (this.pending) {
      const s = await this.pending;
      if (s && s.root === root) return s;
    }
    return this.refresh();
  }

  private async load(): Promise<Snapshot | undefined> {
    const repo = this.manager.current;
    if (!repo) {
      void vscode.commands.executeCommand('setContext', 'gitRepository.hasStashes', false);
      void vscode.commands.executeCommand('setContext', 'gitRepository.operationInProgress', false);
      return undefined;
    }
    const [head, refs, remotes, stashes, worktrees, submodules, operation] = await Promise.all([
      repo.getHead(),
      repo.getRefs(),
      repo.getRemotes(),
      repo.getStashes(),
      repo.getWorktrees(),
      repo.getSubmodules(),
      repo.getOperation(),
    ]);
    void vscode.commands.executeCommand('setContext', 'gitRepository.operationInProgress', !!operation);
    void vscode.commands.executeCommand('setContext', 'gitRepository.hasStashes', stashes.length > 0);
    return { root: repo.root, head, refs, remotes, stashes, worktrees, submodules };
  }

  // ---------------------------------------------------------------- tree

  tree(snapshot = this.current): RefTreeNode[] {
    if (!snapshot) return [];
    const root = snapshot.root;
    return GROUPS.map(g => {
      let children: RefTreeNode[];
      let count: number | undefined;
      switch (g.kind) {
        case 'branches':
          children = this.refNodes(snapshot, 'branches', '', undefined);
          break;
        case 'tags':
          children = this.refNodes(snapshot, 'tags', '', undefined);
          count = snapshot.refs.filter(r => r.type === 'tag').length;
          break;
        case 'remotes':
          children = snapshot.remotes.map(remote => ({
            id: `${root}|remote|${remote.name}`,
            label: remote.name,
            description: remote.fetchUrl,
            tooltip: `${remote.name}\nFetch: ${remote.fetchUrl ?? ''}\nPush: ${remote.pushUrl ?? ''}`,
            icon: 'cloud',
            context: { webviewSection: 'tree', treeItem: 'remote' },
            children: nonEmpty(this.refNodes(snapshot, 'remotes', '', remote.name), info(root, `remote-${remote.name}`, 'No remote branches')),
            expanded: true,
          }));
          break;
        case 'stashes':
          children = snapshot.stashes.map(stash => this.stashNode(root, stash));
          count = snapshot.stashes.length;
          break;
        case 'worktrees': {
          const linked = snapshot.worktrees.filter(w => !w.isMain);
          children = linked.map(w => this.worktreeNode(root, w));
          count = linked.length;
          break;
        }
        case 'submodules':
          children = snapshot.submodules.map(s => this.submoduleNode(root, s));
          count = snapshot.submodules.length;
          break;
      }
      if (children.length === 0) children = [info(root, g.kind, EMPTY_LABELS[g.kind])];
      return {
        id: `${root}|group|${g.kind}`,
        label: g.label,
        description: count === undefined ? undefined : String(count),
        icon: g.icon,
        context: { webviewSection: 'tree', treeItem: `group:${g.kind}` },
        children,
        expanded: g.expanded,
        actions: GROUP_ACTIONS[g.kind],
      };
    });
  }

  /** Builds folder/ref nodes for refs whose (relative) name starts with `prefix`. */
  private refNodes(data: Snapshot, group: 'branches' | 'remotes' | 'tags', prefix: string, remote: string | undefined): RefTreeNode[] {
    let refs: { ref: GitRef; rel: string }[];
    if (group === 'branches') {
      refs = data.refs.filter(r => r.type === 'branch').map(ref => ({ ref, rel: ref.name }));
    } else if (group === 'tags') {
      refs = data.refs.filter(r => r.type === 'tag').map(ref => ({ ref, rel: ref.name }));
    } else {
      refs = data.refs.filter(r => r.type === 'remote' && r.remote === remote).map(ref => ({ ref, rel: ref.name.slice(remote!.length + 1) }));
    }
    refs = refs.filter(r => r.rel.startsWith(prefix));

    const folders = new Map<string, string>();
    const leaves: GitRef[] = [];
    for (const { ref, rel } of refs) {
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash > 0) folders.set(prefix + rest.slice(0, slash) + '/', rest.slice(0, slash));
      else leaves.push(ref);
    }

    const top = group === 'branches' && prefix === '';
    leaves.sort((a, b) => {
      if (top) {
        // Keep the current branch and common default branches on top, like Visual Studio.
        const rank = (r: GitRef) => (r.isCurrent ? 0 : r.name === 'main' || r.name === 'master' ? 1 : 2);
        const d = rank(a) - rank(b);
        if (d) return d;
      }
      if (group === 'tags') return (b.date ?? '').localeCompare(a.date ?? '') || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });

    const worktreeByBranch = new Map(data.worktrees.filter(w => !w.isMain && w.branch).map(w => [w.branch!, w.path]));
    const leafNodes = leaves.map(ref => this.refNode(data.root, ref, ref.type === 'branch' ? worktreeByBranch.get(ref.name) : undefined));
    const folderNodes: RefTreeNode[] = [...folders.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([folderPrefix, label]) => ({
        id: `${data.root}|folder|${group}|${remote ?? ''}|${folderPrefix}`,
        label,
        icon: 'folder',
        context: { webviewSection: 'tree', treeItem: 'folder' },
        children: this.refNodes(data, group, folderPrefix, remote),
      }));
    // Base branches (main, test, staging, ...) before folders (feature/, fix/, ...).
    return [...leafNodes, ...folderNodes];
  }

  private refNode(root: string, ref: GitRef, worktreePath: string | undefined): RefTreeNode {
    const leaf = ref.type === 'remote' ? ref.name.slice((ref.remote?.length ?? 0) + 1).split('/').pop()! : ref.name.split('/').pop()!;
    let icon: string;
    let treeItem: string;
    let description: string | undefined;
    const actions: RefTreeAction[] = [];
    if (ref.type === 'branch') {
      icon = ref.isCurrent ? 'check' : worktreePath ? 'worktree' : 'git-branch';
      const parts: string[] = [];
      if (ref.upstream) {
        if (ref.upstreamGone) parts.push('upstream gone');
        else if (ref.ahead || ref.behind) parts.push(`${ref.ahead}↑ ${ref.behind}↓`);
      }
      if (worktreePath) parts.push(`worktree: ${baseName(worktreePath)}`);
      description = parts.join('  ') || undefined;
      treeItem = `ref:branch:${ref.isCurrent ? 'current' : 'other'}${ref.upstream ? ':upstream' : ''}`;
      actions.push(ref.isCurrent ? action('pushBranch', 'repo-push', 'Push') : action('checkout', 'check', 'Checkout'));
    } else if (ref.type === 'remote') {
      icon = 'git-branch';
      treeItem = 'ref:remote';
      actions.push(action('checkout', 'check', 'Checkout'));
    } else {
      icon = 'tag';
      treeItem = 'ref:tag';
      actions.push(action('checkout', 'check', 'Checkout'));
    }

    const lines = [`${ref.name}${ref.isCurrent ? ' (current)' : ''}`];
    if (ref.upstream) lines.push(`Tracking ${ref.upstream}${ref.upstreamGone ? ' (gone)' : ` — ${ref.ahead ?? 0} outgoing, ${ref.behind ?? 0} incoming`}`);
    lines.push(`${ref.commit.slice(0, 8)} ${ref.subject ?? ''}`);
    if (ref.date) lines.push(new Date(ref.date).toLocaleString());
    if (worktreePath) lines.push(`Checked out in worktree ${worktreePath}`);

    return {
      id: `${root}|ref|${ref.fullName}`,
      label: leaf,
      description,
      tooltip: lines.join('\n'),
      icon,
      emphasis: ref.isCurrent,
      refFull: ref.fullName,
      context: { webviewSection: 'tree', treeItem, refFull: ref.fullName },
      actions,
      command: 'gitRepository.showHistory',
      dblCommand: ref.isCurrent ? undefined : 'gitRepository.checkout',
    };
  }

  private stashNode(root: string, s: Stash): RefTreeNode {
    return {
      id: `${root}|stash|${s.hash}`,
      label: s.message || '(no message)',
      description: [s.ref, s.branch ? `on ${s.branch}` : '', relativeTime(s.date)].filter(Boolean).join(' · '),
      tooltip: `${s.ref}${s.branch ? ` on ${s.branch}` : ''}\n${s.message}\n${new Date(s.date).toLocaleString()}\n${s.hash.slice(0, 8)}${s.parents[2] ? ' · includes untracked files' : ''}`,
      icon: 'git-stash',
      context: { webviewSection: 'tree', treeItem: 'stash', stashHash: s.hash },
      children: [],
      lazy: true,
      actions: [action('applyStash', 'git-stash-apply', 'Apply Stash'), action('popStash', 'git-stash-pop', 'Pop Stash')],
    };
  }

  /** File nodes for a stash, loaded when the stash is expanded. */
  async stashFileNodes(stashHash: string): Promise<RefTreeNode[]> {
    const repo = this.manager.current;
    const stash = this.current?.stashes.find(s => s.hash === stashHash);
    if (!repo || !stash) return [];
    const files = await repo.getStashFiles(stash);
    if (files.length === 0) return [info(repo.root, `stash-${stashHash}`, 'No changes')];
    return files.map(f => {
      const status = f.untracked ? 'U' : f.status;
      const slash = f.path.lastIndexOf('/');
      return {
        id: `${repo.root}|stashFile|${stashHash}|${f.untracked ? 'u' : 't'}|${f.path}`,
        label: slash >= 0 ? f.path.slice(slash + 1) : f.path,
        description: `${slash >= 0 ? f.path.slice(0, slash) : ''}  ${status}`.trim(),
        tooltip: `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}\n${f.untracked ? 'Untracked' : STATUS_LABELS[f.status] ?? f.status}`,
        icon: 'file',
        context: {
          webviewSection: 'tree',
          treeItem: `stashFile:${f.status === 'D' ? 'deleted' : 'present'}`,
          stashHash,
          filePath: f.path,
          fileOldPath: f.oldPath ?? '',
          fileStatus: f.status,
          untracked: !!f.untracked,
        },
        actions: [action('openStashWorkingFile', 'go-to-file', 'Open Working File')],
        command: 'gitRepository.openStashFileDiff',
      };
    });
  }

  private worktreeNode(root: string, wt: Worktree): RefTreeNode {
    let description = wt.branch ?? (wt.head ? `detached at ${wt.head.slice(0, 8)}` : '');
    if (wt.prunable) description += ' (prunable)';
    return {
      id: `${root}|worktree|${wt.path}`,
      label: baseName(wt.path),
      description,
      tooltip: `${wt.path}\n${wt.branch ? `Branch: ${wt.branch}` : `Detached HEAD: ${wt.head ?? ''}`}${wt.locked ? `\nLocked${wt.lockReason ? `: ${wt.lockReason}` : ''}` : ''}`,
      icon: wt.locked ? 'lock' : 'worktree',
      context: { webviewSection: 'tree', treeItem: `worktree:linked:${wt.locked ? 'locked' : 'unlocked'}`, worktreePath: wt.path },
      actions: [action('openWorktree', 'empty-window', 'Open in New Window')],
      dblCommand: 'gitRepository.openWorktree',
    };
  }

  private submoduleNode(root: string, sm: Submodule): RefTreeNode {
    const state = sm.state === '-' ? 'not initialized' : sm.state === '+' ? 'modified' : sm.state === 'U' ? 'conflict' : '';
    const initialized = sm.state !== '-';
    return {
      id: `${root}|submodule|${sm.path}`,
      label: sm.path,
      description: [sm.commit.slice(0, 8), sm.describe ? `(${sm.describe})` : '', state].filter(Boolean).join(' '),
      tooltip: `${sm.path}\nURL: ${sm.url ?? ''}\nCommit: ${sm.commit}${state ? `\nState: ${state}` : ''}`,
      icon: 'file-submodule',
      context: { webviewSection: 'tree', treeItem: `submodule:${initialized ? 'initialized' : 'uninitialized'}`, submodulePath: sm.path },
      actions: initialized ? [action('openSubmodule', 'empty-window', 'Open in New Window')] : undefined,
      dblCommand: initialized ? 'gitRepository.openSubmodule' : undefined,
    };
  }

  // ---------------------------------------------------------------- resolving menu arguments

  /** Turns the `data-vscode-context` of a branches-pane node back into the object it represents. */
  async resolve(ctx: RefTreeContext): Promise<TreeNode | undefined> {
    const data = await this.ensure();
    if (!data) return undefined;
    if (ctx.treeItem.startsWith('group:')) return { kind: 'group', group: ctx.treeItem.slice(6) as GroupKind };
    if (ctx.refFull) {
      const ref = data.refs.find(r => r.fullName === ctx.refFull);
      if (!ref) return undefined;
      const worktreePath = ref.type === 'branch' ? data.worktrees.find(w => !w.isMain && w.branch === ref.name)?.path : undefined;
      return { kind: 'ref', ref, worktreePath };
    }
    if (ctx.stashHash) {
      const stash = data.stashes.find(s => s.hash === ctx.stashHash);
      if (!stash) return undefined;
      if (ctx.filePath === undefined) return { kind: 'stash', stash };
      const file: StashFile = { status: ctx.fileStatus ?? 'M', path: ctx.filePath, oldPath: ctx.fileOldPath || undefined, untracked: !!ctx.untracked };
      return { kind: 'stashFile', stash, file };
    }
    if (ctx.worktreePath) {
      const worktree = data.worktrees.find(w => w.path === ctx.worktreePath);
      return worktree && { kind: 'worktree', worktree };
    }
    if (ctx.submodulePath) {
      const submodule = data.submodules.find(s => s.path === ctx.submodulePath);
      return submodule && { kind: 'submodule', submodule };
    }
    return undefined;
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this._onDidChange.dispose();
  }
}

const EMPTY_LABELS: Record<GroupKind, string> = {
  branches: 'No branches',
  remotes: 'No remotes',
  tags: 'No tags',
  stashes: 'No stashes',
  worktrees: 'No linked worktrees',
  submodules: 'No submodules',
};

function info(root: string, key: string, label: string): RefTreeNode {
  return { id: `${root}|info|${key}`, label, context: { webviewSection: 'tree', treeItem: 'info' }, noFilter: true };
}

function nonEmpty(nodes: RefTreeNode[], placeholder: RefTreeNode): RefTreeNode[] {
  return nodes.length ? nodes : [placeholder];
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (seconds >= size) return fmt.format(-Math.floor(seconds / size), unit);
  return fmt.format(0, 'second');
}
