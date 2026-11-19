import * as path from 'node:path';
import * as vscode from 'vscode';
import { openCommitFileDiff } from '../diff';
import type { GitRepository } from '../git/repository';
import type { RepoManager } from '../repoManager';
import type { CommitFile, CommitRow, FromWebview, HistoryState, ToWebview } from '../shared/protocol';
import { webviewHtml, webviewOptions } from './webviewHtml';

/** "View History" for a single file: one editor tab per file, listing the commits that changed it. */
export class FileHistoryPanels implements vscode.Disposable {
  static readonly viewType = 'gitRepository.fileHistory';

  private readonly panels = new Map<string, FileHistoryPanel>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    manager: RepoManager,
  ) {
    this.disposables.push(
      manager.onDidChangeRepository(repo => {
        for (const p of this.panels.values()) if (p.repo.root === repo.root) void p.reload(true);
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gitRepository')) for (const p of this.panels.values()) void p.reload(true);
      }),
    );
  }

  show(repo: GitRepository, relPath: string): FileHistoryPanel {
    const file = relPath.replace(/\\/g, '/');
    const key = `${repo.root}\0${file}`;
    let panel = this.panels.get(key);
    if (panel) {
      panel.reveal();
    } else {
      panel = new FileHistoryPanel(this.context.extensionUri, repo, file, () => this.panels.delete(key));
      this.panels.set(key, panel);
    }
    return panel;
  }

  find(root: string, relPath: string): FileHistoryPanel | undefined {
    return this.panels.get(`${root}\0${relPath.replace(/\\/g, '/')}`);
  }

  dispose(): void {
    for (const p of [...this.panels.values()]) p.dispose();
    vscode.Disposable.from(...this.disposables).dispose();
  }
}

export class FileHistoryPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private loadToken = 0;
  private hasMore = false;
  private selected?: string;
  /** Rows loaded so far, newest first. */
  commits: CommitRow[] = [];
  readyCount = 0;

  constructor(
    extensionUri: vscode.Uri,
    readonly repo: GitRepository,
    readonly file: string,
    onDispose: () => void,
  ) {
    const title = `History - ${path.posix.basename(file)}`;
    this.panel = vscode.window.createWebviewPanel(FileHistoryPanels.viewType, title, vscode.ViewColumn.Active, webviewOptions(extensionUri));
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'git-repository.svg');
    this.panel.webview.html = webviewHtml(extensionUri, this.panel.webview, 'file', title);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
      this.panel.onDidDispose(() => {
        onDispose();
        vscode.Disposable.from(...this.disposables).dispose();
      }),
    );
  }

  get isVisible(): boolean {
    return this.panel.visible;
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  private post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.readyCount++;
        await this.reload();
        break;
      case 'refresh':
        await this.reload(true);
        break;
      case 'selectCommit':
        this.selected = message.hash;
        await this.sendDetails(message.hash);
        break;
      case 'loadMore':
        await this.loadMore();
        break;
      case 'command':
        if (message.command.startsWith('gitRepository.')) {
          await vscode.commands.executeCommand(message.command, ...(message.args ?? []));
        }
        break;
      case 'openFile':
        await this.openFile(message.hash, message.file);
        break;
    }
  }

  private pageSize(): number {
    return Math.max(50, vscode.workspace.getConfiguration('gitRepository').get<number>('pageSize', 400));
  }

  async reload(preserve = false): Promise<void> {
    const token = ++this.loadToken;
    this.post({ type: 'loading', value: true });
    try {
      const pageSize = this.pageSize();
      const [head, commits] = await Promise.all([this.repo.getHead(), this.repo.fileLog(this.file, Math.max(this.commits.length, pageSize) + 1)]);
      if (token !== this.loadToken) return;
      this.hasMore = commits.length > Math.max(this.commits.length, pageSize);
      if (this.hasMore) commits.pop();
      this.commits = commits;
      const headLabel = head.branch ?? (head.commit ? head.commit.slice(0, 8) : 'HEAD');
      const state: HistoryState = {
        repoName: this.repo.name,
        repoRoot: this.repo.root,
        refLabel: headLabel,
        refType: head.branch ? 'branch' : 'commit',
        headLabel,
        headHash: head.commit,
        ahead: 0,
        behind: 0,
        hasRemotes: false,
        options: { mode: 'current', showRemotes: true, showTags: true, firstParent: false },
        filter: '',
        dateFormat: vscode.workspace.getConfiguration('gitRepository').get('dateFormat', 'locale'),
        file: this.file,
      };
      this.post({ type: 'state', state });
      this.post({ type: 'history', data: { commits, hasMore: this.hasMore, outgoing: [], incomingHashes: [], isSearch: false }, preserveSelection: preserve });
    } catch (e) {
      if (token === this.loadToken) this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (token === this.loadToken) this.post({ type: 'loading', value: false });
    }
  }

  private async loadMore(): Promise<void> {
    if (!this.hasMore) return;
    const token = this.loadToken;
    const loaded = this.commits.length;
    const all = await this.repo.fileLog(this.file, loaded + this.pageSize() + 1);
    if (token !== this.loadToken) return;
    this.hasMore = all.length > loaded + this.pageSize();
    if (this.hasMore) all.pop();
    const commits = all.slice(loaded);
    this.commits.push(...commits);
    this.post({ type: 'more', commits, hasMore: this.hasMore });
  }

  private async sendDetails(hash: string): Promise<void> {
    try {
      const details = await this.repo.getCommitDetails(hash);
      if (this.selected === hash) this.post({ type: 'details', details, hash });
    } catch (e) {
      this.post({ type: 'details', details: undefined, hash });
      this.post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async openFile(hash: string, file: CommitFile): Promise<void> {
    const details = await this.repo.getCommitDetails(hash);
    await openCommitFileDiff(this.repo, hash, details.parents[0], file);
  }

  dispose(): void {
    this.panel.dispose();
  }
}
