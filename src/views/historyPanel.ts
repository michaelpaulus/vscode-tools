import * as vscode from 'vscode';
import type { Activity } from '../activity';
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
import { webviewHtml, webviewOptions } from './webviewHtml';

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
  /** The displayed ref changed: the webview clears the old history right away instead of showing it until the new one loads. */
  private switching = false;
  private selected?: string;
  private pendingSelect?: string;
  private readonly disposables: vscode.Disposable[] = [];
  private panelDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: RepoManager,
    private readonly refs: RefsModel,
    private readonly activity: Activity,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...context.workspaceState.get<Partial<HistoryOptions>>(OPTIONS_KEY) };
    this.disposables.push(
      manager.onDidChangeCurrent(() => {
        this.target = undefined;
        this.filter = '';
        void this.reload();
      }),
      refs.onDidChange(() => this.postTree()),
      activity.onDidChange(() => this.post({ type: 'activity', tasks: activity.tasks })),
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

  /** Opens the panel and selects `hash` once the history has loaded. */
  showCommit(hash: string): void {
    this.pendingSelect = hash;
    this.show(undefined, true);
  }

  /** Opens or reveals the panel. `target` undefined keeps the displayed ref; `reload` false skips reloading an open panel. */
  show(target?: HistoryTarget | null, reload = true): void {
    if (target !== undefined) {
      this.switching = this.target?.fullName !== target?.fullName || !!this.filter;
      this.target = target ?? undefined;
      this.targetRepo = this.manager.current?.root;
      this.filter = '';
    }
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (reload) void this.reload();
      return;
    }
    const panel = vscode.window.createWebviewPanel(HistoryPanel.viewType, 'Git Repository', vscode.ViewColumn.Active, webviewOptions(this.context.extensionUri));
    this.adopt(panel);
    if (vscode.workspace.getConfiguration('gitRepository').get<boolean>('fetchOnOpen')) {
      void vscode.commands.executeCommand('gitRepository.fetch');
    }
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'git-repository.svg');
    panel.webview.options = webviewOptions(this.context.extensionUri);
    panel.webview.html = webviewHtml(this.context.extensionUri, panel.webview, 'repository', 'Git Repository');
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
        this.post({ type: 'activity', tasks: this.activity.tasks });
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
    if (this.switching && !preserve) {
      const current = this.refs.snapshot?.root === repo.root ? this.refs.snapshot.refs.find(r => r.isCurrent) : undefined;
      const ref = this.target ?? current;
      this.post({ type: 'switching', label: ref?.name, refType: ref?.type, refFull: ref?.fullName });
    }
    this.switching = false;
    this.post({ type: 'loading', value: true });
    try {
      const data = await this.query(repo, state => {
        // The header is cheap to compute; show it before the (slower) history arrives.
        if (token === this.loadToken) this.post({ type: 'state', state });
      });
      if (token !== this.loadToken) return;
      this.panel.title = `Git Repository - ${repo.name}`;
      this.post({ type: 'history', data, preserveSelection: preserve });
      if (this.pendingSelect) {
        this.post({ type: 'select', hash: this.pendingSelect });
        this.pendingSelect = undefined;
      }
    } catch (e) {
      if (token === this.loadToken) this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (token === this.loadToken) this.post({ type: 'loading', value: false });
    }
  }

  private async query(repo: GitRepository, onState: (state: HistoryState) => void): Promise<HistoryData> {
    const [head, operation, remotes, targetExists] = await Promise.all([
      repo.getHead(),
      repo.getOperation(),
      repo.getRemotes(),
      this.target ? repo.tryRevParse(this.target.fullName) : Promise.resolve(undefined),
    ]);

    if (this.target && !targetExists) this.target = undefined;
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
    const all = this.options.mode === 'all';
    // Visual Studio style: in "current" mode, "Incoming" lists upstream commits and "Local History" the ref itself.
    this.revs = all
      ? ['HEAD', '--branches', ...(this.options.showRemotes ? ['--remotes'] : []), ...(this.options.showTags ? ['--tags'] : [])]
      : [rev];
    const searchRevs = all ? this.revs : [rev, ...(upstream ? [upstream] : [])];
    const pageSize = this.pageSize();
    const firstParent = this.options.firstParent;

    // Run the git queries concurrently instead of one after another.
    const countsP = upstream ? repo.aheadBehind(rev, upstream) : Promise.resolve({ ahead: 0, behind: 0 });
    const outgoingP = upstream ? repo.revList(`${upstream}..${rev}`) : Promise.resolve([]);
    const incomingHashesP = upstream ? repo.revList(`${rev}..${upstream}`) : Promise.resolve([]);
    const incomingP = !all && !this.filter && upstream ? repo.log({ revs: [`${rev}..${upstream}`], maxCount: 1000, firstParent }) : Promise.resolve(all || this.filter ? undefined : []);
    const commitsP = this.filter ? repo.search(searchRevs, this.filter, 1000, firstParent) : repo.log({ revs: this.revs, maxCount: pageSize + 1, firstParent });
    // Once one query fails the rest are no longer awaited; keep their failures from surfacing as unhandled rejections.
    for (const p of [countsP, outgoingP, incomingHashesP, incomingP, commitsP]) (p as Promise<unknown>).catch(() => undefined);

    const counts = await countsP;
    onState({
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
    });

    const [commits, incoming, outgoing, incomingHashes] = await Promise.all([commitsP, incomingP, outgoingP, incomingHashesP]);
    if (this.filter) {
      this.revs = searchRevs;
      this.loaded = commits.length;
      this.hasMore = false;
      return { commits: this.filterBadges(commits), hasMore: false, outgoing, incomingHashes, isSearch: true };
    }
    this.hasMore = commits.length > pageSize;
    if (this.hasMore) commits.pop();
    this.loaded = commits.length;
    return {
      incoming: incoming && this.filterBadges(incoming),
      commits: this.filterBadges(commits),
      hasMore: this.hasMore,
      outgoing,
      incomingHashes,
      isSearch: false,
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

  dispose(): void {
    this.panel?.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
