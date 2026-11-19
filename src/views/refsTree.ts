import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitRef, Stash, Submodule, Worktree } from '../git/parsers';
import type { HeadInfo, Remote } from '../git/repository';
import type { RepoManager } from '../repoManager';
import type { CommitFile } from '../shared/protocol';

export type GroupKind = 'branches' | 'remotes' | 'tags' | 'stashes' | 'worktrees' | 'submodules';

export type StashFile = CommitFile & { untracked?: boolean };

export type TreeNode =
  | { kind: 'group'; group: GroupKind }
  | { kind: 'remote'; remote: Remote }
  | { kind: 'folder'; group: 'branches' | 'remotes' | 'tags'; prefix: string; remote?: string; label: string }
  | { kind: 'ref'; ref: GitRef; worktreePath?: string }
  | { kind: 'stash'; stash: Stash }
  | { kind: 'stashFile'; stash: Stash; file: StashFile }
  | { kind: 'worktree'; worktree: Worktree }
  | { kind: 'submodule'; submodule: Submodule }
  | { kind: 'info'; label: string };

interface Snapshot {
  root: string;
  head: HeadInfo;
  refs: GitRef[];
  remotes: Remote[];
  stashes: Stash[];
  worktrees: Worktree[];
  submodules: Submodule[];
}

const GROUP_LABELS: Record<GroupKind, string> = {
  branches: 'Branches',
  remotes: 'Remotes',
  tags: 'Tags',
  stashes: 'Stashes',
  worktrees: 'Worktrees',
  submodules: 'Submodules',
};

const GROUP_ICONS: Record<GroupKind, string> = {
  branches: 'git-branch',
  remotes: 'cloud',
  tags: 'tag',
  stashes: 'git-stash',
  worktrees: 'worktree',
  submodules: 'file-submodule',
};

const STATUS_LABELS: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };

export class RefsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private snapshot?: Snapshot;
  private loading?: Promise<Snapshot | undefined>;
  private filterText = '';
  private view?: vscode.TreeView<TreeNode>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: RepoManager) {
    this.disposables.push(
      manager.onDidChangeCurrent(() => this.refresh()),
      manager.onDidChangeRepository(repo => {
        if (repo === manager.current) this.refresh();
      }),
      manager.onDidChangeRepositories(() => this.refresh()),
    );
  }

  attach(view: vscode.TreeView<TreeNode>): void {
    this.view = view;
  }

  get filter(): string {
    return this.filterText;
  }

  setFilter(text: string): void {
    this.filterText = text.trim();
    void vscode.commands.executeCommand('setContext', 'gitRepository.treeFiltered', !!this.filterText);
    if (this.view) this.view.message = this.filterText ? `Filtered by "${this.filterText}"` : undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this.snapshot = undefined;
    this.loading = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  private async load(): Promise<Snapshot | undefined> {
    const repo = this.manager.current;
    if (!repo) return undefined;
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
    if (this.view) {
      const headLabel = head.branch ?? (head.commit ? head.commit.slice(0, 8) : 'no commits');
      this.view.description = `${repo.name} (${headLabel}${operation ? ` | ${operation.toUpperCase()}` : ''})`;
    }
    return { root: repo.root, head, refs, remotes, stashes, worktrees, submodules };
  }

  private async data(): Promise<Snapshot | undefined> {
    if (this.snapshot) return this.snapshot;
    this.loading ??= this.load().catch(e => {
      void vscode.window.showErrorMessage(`Git Repository: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    this.snapshot = await this.loading;
    return this.snapshot;
  }

  private matches(text: string): boolean {
    return !this.filterText || text.toLowerCase().includes(this.filterText.toLowerCase());
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    const data = await this.data();
    if (!data) return [];

    if (!node) {
      const groups: GroupKind[] = ['branches', 'remotes', 'tags', 'stashes', 'worktrees', 'submodules'];
      return groups
        .filter(g => {
          if (g === 'branches') return true;
          if (g === 'submodules') return data.submodules.length > 0 || !this.filterText;
          if (g === 'worktrees') return data.worktrees.length > 1 || !this.filterText;
          return !this.filterText || this.groupHasMatches(data, g);
        })
        .map(group => ({ kind: 'group', group }));
    }

    switch (node.kind) {
      case 'group':
        switch (node.group) {
          case 'branches':
            return this.refChildren(data, 'branches', '', undefined);
          case 'tags':
            return this.refChildren(data, 'tags', '', undefined);
          case 'remotes': {
            const remotes = data.remotes.filter(r => this.remoteRefs(data, r.name).length > 0 || !this.filterText);
            if (remotes.length === 0) return [{ kind: 'info', label: 'No remotes' }];
            return remotes.map(remote => ({ kind: 'remote', remote }));
          }
          case 'stashes': {
            const items = data.stashes.filter(s => this.matches(s.message) || this.matches(s.branch ?? ''));
            return items.length ? items.map(stash => ({ kind: 'stash', stash })) : [{ kind: 'info', label: 'No stashes' }];
          }
          case 'worktrees': {
            const items = data.worktrees
              .filter(w => !w.isMain)
              .filter(w => this.matches(w.path) || this.matches(w.branch ?? ''));
            return items.length ? items.map(worktree => ({ kind: 'worktree', worktree })) : [{ kind: 'info', label: 'No linked worktrees' }];
          }
          case 'submodules': {
            const items = data.submodules.filter(s => this.matches(s.path));
            return items.length ? items.map(submodule => ({ kind: 'submodule', submodule })) : [{ kind: 'info', label: 'No submodules' }];
          }
        }
        return [];
      case 'remote':
        return this.refChildren(data, 'remotes', '', node.remote.name);
      case 'folder':
        return this.refChildren(data, node.group, node.prefix, node.remote);
      case 'stash': {
        const repo = this.manager.current;
        if (!repo) return [];
        const files = await repo.getStashFiles(node.stash);
        return files.length ? files.map(file => ({ kind: 'stashFile', stash: node.stash, file })) : [{ kind: 'info', label: 'No changes' }];
      }
      default:
        return [];
    }
  }

  private groupHasMatches(data: Snapshot, group: GroupKind): boolean {
    if (group === 'remotes') return data.refs.some(r => r.type === 'remote' && this.matches(r.name));
    if (group === 'tags') return data.refs.some(r => r.type === 'tag' && this.matches(r.name));
    if (group === 'stashes') return data.stashes.some(s => this.matches(s.message) || this.matches(s.branch ?? ''));
    return true;
  }

  private remoteRefs(data: Snapshot, remote: string): GitRef[] {
    return data.refs.filter(r => r.type === 'remote' && r.remote === remote && this.matches(r.name));
  }

  /** Builds folder/ref nodes for refs whose (relative) name starts with `prefix`. */
  private refChildren(data: Snapshot, group: 'branches' | 'remotes' | 'tags', prefix: string, remote: string | undefined): TreeNode[] {
    let refs: { ref: GitRef; rel: string }[];
    if (group === 'branches') {
      refs = data.refs.filter(r => r.type === 'branch').map(ref => ({ ref, rel: ref.name }));
    } else if (group === 'tags') {
      refs = data.refs.filter(r => r.type === 'tag').map(ref => ({ ref, rel: ref.name }));
    } else {
      refs = data.refs.filter(r => r.type === 'remote' && r.remote === remote).map(ref => ({ ref, rel: ref.name.slice(remote!.length + 1) }));
    }
    refs = refs.filter(r => this.matches(r.ref.name) && r.rel.startsWith(prefix));

    const folders = new Map<string, TreeNode>();
    const leaves: TreeNode[] = [];
    const worktreeByBranch = new Map(data.worktrees.filter(w => !w.isMain && w.branch).map(w => [w.branch!, w.path]));
    for (const { ref, rel } of refs) {
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash > 0) {
        const name = rest.slice(0, slash);
        const folderPrefix = prefix + name + '/';
        if (!folders.has(folderPrefix)) folders.set(folderPrefix, { kind: 'folder', group, prefix: folderPrefix, remote, label: name });
      } else {
        leaves.push({ kind: 'ref', ref, worktreePath: ref.type === 'branch' ? worktreeByBranch.get(ref.name) : undefined });
      }
    }

    const sortFolders = [...folders.values()].sort((a, b) => (a as { label: string }).label.localeCompare((b as { label: string }).label));
    const sortLeaves = leaves.sort((a, b) => {
      const ra = (a as { ref: GitRef }).ref;
      const rb = (b as { ref: GitRef }).ref;
      if (group === 'branches' && prefix === '') {
        // Keep the current branch and common default branches on top, like Visual Studio.
        const rank = (r: GitRef) => (r.isCurrent ? 0 : r.name === 'main' || r.name === 'master' ? 1 : 2);
        const d = rank(ra) - rank(rb);
        if (d) return d;
      }
      if (group === 'tags') return (rb.date ?? '').localeCompare(ra.date ?? '') || ra.name.localeCompare(rb.name);
      return ra.name.localeCompare(rb.name);
    });
    const result = [...sortLeaves.filter(l => group === 'branches' && prefix === '' && (l as { ref: GitRef }).ref.isCurrent), ...sortFolders, ...sortLeaves.filter(l => !(group === 'branches' && prefix === '' && (l as { ref: GitRef }).ref.isCurrent))];
    if (result.length === 0 && prefix === '') {
      return [{ kind: 'info', label: group === 'tags' ? 'No tags' : group === 'branches' ? 'No branches' : 'No remote branches' }];
    }
    return result;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const root = this.snapshot?.root ?? '';
    const suffix = this.filterText ? `?filter=${this.filterText}` : '';
    const expandedWhenFiltering = this.filterText ? vscode.TreeItemCollapsibleState.Expanded : undefined;

    switch (node.kind) {
      case 'group': {
        const defaultExpanded = node.group === 'branches' || node.group === 'remotes';
        const item = new vscode.TreeItem(
          GROUP_LABELS[node.group],
          expandedWhenFiltering ?? (defaultExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed),
        );
        item.id = `${root}|group|${node.group}${suffix}`;
        item.iconPath = new vscode.ThemeIcon(GROUP_ICONS[node.group]);
        item.contextValue = `group:${node.group}`;
        if (node.group === 'worktrees') item.description = `${Math.max(0, (this.snapshot?.worktrees.length ?? 1) - 1)}`;
        if (node.group === 'submodules') item.description = `${this.snapshot?.submodules.length ?? 0}`;
        if (node.group === 'tags') item.description = `${this.snapshot?.refs.filter(r => r.type === 'tag').length ?? 0}`;
        if (node.group === 'stashes') item.description = `${this.snapshot?.stashes.length ?? 0}`;
        return item;
      }
      case 'remote': {
        const item = new vscode.TreeItem(node.remote.name, expandedWhenFiltering ?? vscode.TreeItemCollapsibleState.Expanded);
        item.id = `${root}|remote|${node.remote.name}${suffix}`;
        item.iconPath = new vscode.ThemeIcon('cloud');
        item.description = node.remote.fetchUrl;
        item.tooltip = `${node.remote.name}\nFetch: ${node.remote.fetchUrl ?? ''}\nPush: ${node.remote.pushUrl ?? ''}`;
        item.contextValue = 'remote';
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.label, expandedWhenFiltering ?? vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${root}|folder|${node.group}|${node.remote ?? ''}|${node.prefix}${suffix}`;
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = 'folder';
        return item;
      }
      case 'ref':
        return this.refItem(node.ref, node.worktreePath, root);
      case 'stash': {
        const s = node.stash;
        const item = new vscode.TreeItem(s.message || '(no message)', expandedWhenFiltering ?? vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `${root}|stash|${s.hash}${suffix}`;
        item.iconPath = new vscode.ThemeIcon('git-stash');
        item.description = [s.ref, s.branch ? `on ${s.branch}` : '', relativeTime(s.date)].filter(Boolean).join(' · ');
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`$(git-stash) **${s.ref}**${s.branch ? ` on \`${s.branch}\`` : ''}\n\n`);
        md.appendText(s.message);
        md.appendMarkdown(`\n\n${new Date(s.date).toLocaleString()}\n\n\`${s.hash.slice(0, 8)}\`${s.parents[2] ? ' · includes untracked files' : ''}`);
        item.tooltip = md;
        item.contextValue = 'stash';
        return item;
      }
      case 'stashFile': {
        const f = node.file;
        const item = new vscode.TreeItem(path.basename(f.path), vscode.TreeItemCollapsibleState.None);
        item.id = `${root}|stashFile|${node.stash.hash}|${f.untracked ? 'u' : 't'}|${f.path}`;
        item.resourceUri = vscode.Uri.file(path.join(root, f.path));
        const dir = path.dirname(f.path);
        const status = f.untracked ? 'U' : f.status;
        item.description = `${dir === '.' ? '' : dir.replace(/\\/g, '/')}  ${status}`.trim();
        item.tooltip = `${f.oldPath ? `${f.oldPath} → ` : ''}${f.path}\n${f.untracked ? 'Untracked' : STATUS_LABELS[f.status] ?? f.status}`;
        item.contextValue = `stashFile:${f.status === 'D' ? 'deleted' : 'present'}`;
        item.command = { command: 'gitRepository.openStashFileDiff', title: 'Open Changes', arguments: [node] };
        return item;
      }
      case 'worktree': {
        const wt = node.worktree;
        const item = new vscode.TreeItem(path.basename(wt.path), vscode.TreeItemCollapsibleState.None);
        item.id = `${root}|worktree|${wt.path}`;
        item.iconPath = new vscode.ThemeIcon(wt.locked ? 'lock' : 'worktree');
        item.description = wt.branch ?? (wt.head ? `detached at ${wt.head.slice(0, 8)}` : '');
        if (wt.prunable) item.description += ' (prunable)';
        item.tooltip = new vscode.MarkdownString(
          `**${wt.path}**\n\n${wt.branch ? `Branch: \`${wt.branch}\`` : `Detached HEAD: \`${wt.head ?? ''}\``}` +
            (wt.locked ? `\n\nLocked${wt.lockReason ? `: ${wt.lockReason}` : ''}` : ''),
        );
        item.contextValue = `worktree:linked:${wt.locked ? 'locked' : 'unlocked'}`;
        item.resourceUri = vscode.Uri.file(wt.path);
        item.command = { command: 'gitRepository.openWorktree', title: 'Open', arguments: [node] };
        return item;
      }
      case 'submodule': {
        const sm = node.submodule;
        const item = new vscode.TreeItem(sm.path, vscode.TreeItemCollapsibleState.None);
        item.id = `${root}|submodule|${sm.path}`;
        item.iconPath = new vscode.ThemeIcon('file-submodule');
        const state = sm.state === '-' ? 'not initialized' : sm.state === '+' ? 'modified' : sm.state === 'U' ? 'conflict' : '';
        item.description = [sm.commit.slice(0, 8), sm.describe ? `(${sm.describe})` : '', state].filter(Boolean).join(' ');
        item.tooltip = new vscode.MarkdownString(`**${sm.path}**\n\nURL: ${sm.url ?? ''}\n\nCommit: \`${sm.commit}\`${state ? `\n\nState: ${state}` : ''}`);
        item.contextValue = `submodule:${sm.state === '-' ? 'uninitialized' : 'initialized'}`;
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'info';
        return item;
      }
    }
  }

  private refItem(ref: GitRef, worktreePath: string | undefined, root: string): vscode.TreeItem {
    const leaf = ref.type === 'remote' ? ref.name.slice((ref.remote?.length ?? 0) + 1).split('/').pop()! : ref.name.split('/').pop()!;
    const label: vscode.TreeItemLabel = ref.isCurrent ? { label: leaf, highlights: [[0, leaf.length]] } : { label: leaf };
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `${root}|ref|${ref.fullName}`;

    if (ref.type === 'branch') {
      item.iconPath = ref.isCurrent ? new vscode.ThemeIcon('check') : new vscode.ThemeIcon(worktreePath ? 'worktree' : 'git-branch');
      const parts: string[] = [];
      if (ref.upstream) {
        if (ref.upstreamGone) parts.push('upstream gone');
        else if (ref.ahead || ref.behind) parts.push(`${ref.ahead}↑ ${ref.behind}↓`);
      }
      if (worktreePath) parts.push(`worktree: ${path.basename(worktreePath)}`);
      item.description = parts.join('  ');
      item.contextValue = `ref:branch:${ref.isCurrent ? 'current' : 'other'}${ref.upstream ? ':upstream' : ''}`;
    } else if (ref.type === 'remote') {
      item.iconPath = new vscode.ThemeIcon('git-branch');
      item.contextValue = 'ref:remote';
    } else {
      item.iconPath = new vscode.ThemeIcon('tag');
      item.contextValue = 'ref:tag';
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`$(${ref.type === 'tag' ? 'tag' : 'git-branch'}) **${ref.name}**${ref.isCurrent ? ' (current)' : ''}\n\n`);
    if (ref.upstream) {
      md.appendMarkdown(`Tracking \`${ref.upstream}\`${ref.upstreamGone ? ' (gone)' : ` — ${ref.ahead ?? 0} outgoing, ${ref.behind ?? 0} incoming`}\n\n`);
    }
    md.appendMarkdown(`\`${ref.commit.slice(0, 8)}\` ${ref.subject ?? ''}`);
    if (ref.date) md.appendMarkdown(`\n\n${new Date(ref.date).toLocaleString()}`);
    if (worktreePath) md.appendMarkdown(`\n\nChecked out in worktree \`${worktreePath}\``);
    item.tooltip = md;
    item.command = { command: 'gitRepository.showHistory', title: 'View History', arguments: [{ kind: 'ref', ref }] };
    return item;
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this._onDidChangeTreeData.dispose();
  }
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) if (seconds >= size) return fmt.format(-Math.floor(seconds / size), unit);
  return fmt.format(0, 'second');
}
