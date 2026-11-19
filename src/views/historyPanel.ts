import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { GitRepository } from '../git/repository';
import type { RepoManager } from '../repoManager';
import type {
  CommitFile,
  CommitRow,
  FromWebview,
  HistoryData,
  HistoryOptions,
  HistoryState,
  RefType,
  ToWebview,
} from '../shared/protocol';
import { openCommitFileDiff } from '../diff';
import type { RefsModel } from './refsModel';

export interface HistoryTarget {
  type: Exclude<RefType, 'head'> | 'commit';
  name: string;
  fullName: string;
}

const OPTIONS_KEY = 'gitRepository.historyOptions';
const DEFAULT_OPTIONS: HistoryOptions = { mode: 'current', showRemotes: true, showTags: true, firstParent: false };

export class HistoryPanel implements vscode.Disposable {
  static readonly viewType = 'gitRepository.history';

  private panel?: vscode.WebviewPanel;
  private target?: HistoryTarget;
  private targetRepo?: string;
  private options: HistoryOptions;
  private filter = '';
  private loaded = 0;
  private hasMore = false;
  private revs: string[] = [];
  private loadToken = 0;
  private selected?: string;
  private readonly disposables: vscode.Disposable[] = [];
  private panelDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: RepoManager,
    private readonly refs: RefsModel,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...context.workspaceState.get<Partial<HistoryOptions>>(OPTIONS_KEY) };
    this.disposables.push(
      manager.onDidChangeCurrent(() => {
        this.target = undefined;
        this.filter = '';
        void this.reload();
      }),
      refs.onDidChange(() => this.postTree()),
      manager.onDidChangeRepository(repo => {
        if (repo === manager.current) void this.reload(true);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitRepository')) void this.reload(true);
      }),
      vscode.window.registerWebviewPanelSerializer(HistoryPanel.viewType, {
        deserializeWebviewPanel: async panel => {
          this.adopt(panel);
        },
      }),
    );
  }

  /** Number of times the webview script has loaded and reported ready. */
  readyCount = 0;

  get isVisible(): boolean {
    return !!this.panel?.visible;
  }

  /** Commit currently selected in the history grid. */
  get selectedCommit(): string | undefined {
    return this.selected;
  }

  /** Opens or reveals the panel. `target` undefined keeps the displayed ref; `reload` false skips reloading an open panel. */
  show(target?: HistoryTarget | null, reload = true): void {
    if (target !== undefined) {
      this.target = target ?? undefined;
      this.targetRepo = this.manager.current?.root;
      this.filter = '';
    }
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (reload) void this.reload();
      return;
    }
    const panel = vscode.window.createWebviewPanel(HistoryPanel.viewType, 'Git Repository', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    });
    this.adopt(panel);
    if (vscode.workspace.getConfiguration('gitRepository').get<boolean>('fetchOnOpen')) {
      void vscode.commands.executeCommand('gitRepository.fetch');
    }
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'git-repository.svg');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    panel.webview.html = this.html(panel.webview);
    this.panelDisposables = [
      panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
      panel.onDidDispose(() => {
        this.panel = undefined;
        vscode.Disposable.from(...this.panelDisposables).dispose();
        this.panelDisposables = [];
      }),
    ];
  }

  post(message: ToWebview): void {
    void this.panel?.webview.postMessage(message);
  }

  private async onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.readyCount++;
        void this.refs.ensure().then(() => this.postTree());
        await this.reload();
        break;
      case 'selectCommit':
        this.selected = message.hash;
        await this.sendDetails(message.hash);
        break;
      case 'loadMore':
        await this.loadMore();
        break;
      case 'setOption':
        this.options = { ...this.options, [message.key]: message.value };
        await this.context.workspaceState.update(OPTIONS_KEY, this.options);
        await this.reload();
        break;
      case 'filter':
        this.filter = message.text.trim();
        await this.reload();
        break;
      case 'command':
        if (message.command.startsWith('gitRepository.') || message.command === 'workbench.view.scm') {
          await vscode.commands.executeCommand(message.command, ...(message.args ?? []));
        }
        break;
      case 'treeChildren':
        this.post({ type: 'treeChildren', id: message.id, nodes: await this.refs.stashFileNodes(message.stashHash) });
        break;
      case 'openFile':
        await this.openFile(message.hash, message.file);
        break;
    }
  }

  private postTree(): void {
    const snapshot = this.refs.snapshot;
    this.post({ type: 'tree', nodes: this.refs.tree(snapshot), root: snapshot?.root ?? '' });
  }

  private async openFile(hash: string, file: CommitFile): Promise<void> {
    const repo = this.manager.current;
    if (!repo) return;
    const details = await repo.getCommitDetails(hash);
    await openCommitFileDiff(repo, hash, details.parents[0], file);
  }

  private async sendDetails(hash: string): Promise<void> {
    const repo = this.manager.current;
    if (!repo) return;
    try {
      const details = await repo.getCommitDetails(hash);
      if (this.selected === hash) this.post({ type: 'details', details, hash });
    } catch (e) {
      this.post({ type: 'details', details: undefined, hash });
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private pageSize(): number {
    return Math.max(50, vscode.workspace.getConfiguration('gitRepository').get<number>('pageSize', 400));
  }

  private filterBadges(commits: CommitRow[]): CommitRow[] {
    if (this.options.showRemotes && this.options.showTags) return commits;
    for (const c of commits) {
      c.refs = c.refs.filter(r => (this.options.showRemotes || r.type !== 'remote') && (this.options.showTags || r.type !== 'tag'));
    }
    return commits;
  }

  /** Reloads state and history. `preserve` keeps the selection/scroll (used for background refreshes). */
  async reload(preserve = false): Promise<void> {
    if (!this.panel) return;
    const token = ++this.loadToken;
    const repo = this.manager.current;
    if (!repo) {
      this.post({ type: 'error', message: 'No Git repository is open in this workspace.' });
      return;
    }
    if (this.targetRepo && this.targetRepo !== repo.root) {
      this.target = undefined;
    }
    this.post({ type: 'loading', value: true });
    try {
      const result = await this.query(repo);
      if (token !== this.loadToken) return;
      this.panel.title = `Git Repository - ${repo.name}`;
      this.post({ type: 'state', state: result.state });
      this.post({ type: 'history', data: result.data, preserveSelection: preserve });
    } catch (e) {
      if (token === this.loadToken) this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (token === this.loadToken) this.post({ type: 'loading', value: false });
    }
  }

  private async query(repo: GitRepository): Promise<{ state: HistoryState; data: HistoryData }> {
    const [head, operation, remotes] = await Promise.all([repo.getHead(), repo.getOperation(), repo.getRemotes()]);

    if (this.target && !(await repo.tryRevParse(this.target.fullName))) this.target = undefined;
    const target = this.target;

    const rev = target?.fullName ?? 'HEAD';
    let refLabel: string;
    let refType: HistoryState['refType'];
    let upstream: string | undefined;
    if (target) {
      refLabel = target.name;
      refType = target.type;
      if (target.type === 'branch') upstream = await repo.getUpstream(target.name);
    } else {
      refLabel = head.branch ?? (head.commit ? head.commit.slice(0, 8) : 'HEAD');
      refType = head.branch ? 'branch' : 'commit';
      upstream = head.upstream;
    }
    const counts = upstream ? await repo.aheadBehind(rev, upstream) : { ahead: 0, behind: 0 };
    const state: HistoryState = {
      repoName: repo.name,
      repoRoot: repo.root,
      refLabel,
      refType,
      refFull: target ? target.fullName : head.branch ? `refs/heads/${head.branch}` : undefined,
      headLabel: head.branch ?? (head.commit ? head.commit.slice(0, 8) : 'HEAD'),
      headHash: head.commit,
      upstream,
      ahead: counts.ahead,
      behind: counts.behind,
      operation,
      hasRemotes: remotes.length > 0,
      options: this.options,
      filter: this.filter,
      dateFormat: vscode.workspace.getConfiguration('gitRepository').get('dateFormat', 'locale'),
    };

    const all = this.options.mode === 'all';
    this.revs = all
      ? ['HEAD', '--branches', ...(this.options.showRemotes ? ['--remotes'] : []), ...(this.options.showTags ? ['--tags'] : [])]
      : [rev, ...(upstream ? [upstream] : [])];

    const outgoingP = upstream ? repo.revList(`${upstream}..${rev}`) : Promise.resolve([]);
    const incomingHashesP = upstream ? repo.revList(`${rev}..${upstream}`) : Promise.resolve([]);

    if (this.filter) {
      const commits = await repo.search(this.revs, this.filter, 1000, this.options.firstParent);
      this.loaded = commits.length;
      this.hasMore = false;
      return {
        state,
        data: { commits: this.filterBadges(commits), hasMore: false, outgoing: await outgoingP, incomingHashes: await incomingHashesP, isSearch: true },
      };
    }

    const pageSize = this.pageSize();
    let incoming: CommitRow[] | undefined;
    if (!all) {
      // Visual Studio style: "Incoming" lists upstream commits, "Local History" lists the ref itself.
      this.revs = [rev];
      incoming = upstream ? await repo.log({ revs: [`${rev}..${upstream}`], maxCount: 1000, firstParent: this.options.firstParent }) : [];
    }
    const commits = await repo.log({ revs: this.revs, maxCount: pageSize + 1, firstParent: this.options.firstParent });
    this.hasMore = commits.length > pageSize;
    if (this.hasMore) commits.pop();
    this.loaded = commits.length;

    return {
      state,
      data: {
        incoming: incoming && this.filterBadges(incoming),
        commits: this.filterBadges(commits),
        hasMore: this.hasMore,
        outgoing: await outgoingP,
        incomingHashes: await incomingHashesP,
        isSearch: false,
      },
    };
  }

  private async loadMore(): Promise<void> {
    const repo = this.manager.current;
    if (!repo || !this.hasMore || this.filter) return;
    const token = this.loadToken;
    const pageSize = this.pageSize();
    const commits = await repo.log({ revs: this.revs, skip: this.loaded, maxCount: pageSize + 1, firstParent: this.options.firstParent });
    if (token !== this.loadToken) return;
    this.hasMore = commits.length > pageSize;
    if (this.hasMore) commits.pop();
    this.loaded += commits.length;
    this.post({ type: 'more', commits: this.filterBadges(commits), hasMore: this.hasMore });
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const dist = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', f));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${dist('codicons/codicon.css')}">
<link rel="stylesheet" href="${dist('webview.css')}">
<title>Git Repository</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="app"></div>
<script nonce="${nonce}" src="${dist('webview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
