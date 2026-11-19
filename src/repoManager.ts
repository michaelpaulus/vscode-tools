import * as path from 'node:path';
import * as vscode from 'vscode';
import { GitCli } from './git/cli';
import { GitRepository } from './git/repository';
import type { GitAPI, GitApiRepository, GitExtension } from './git/vscodeGit';

const CURRENT_KEY = 'gitRepository.currentRoot';

function key(root: string): string {
  const normalized = path.normalize(root);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Tracks the git repositories in the workspace and which one the Git Repository window is showing. */
export class RepoManager implements vscode.Disposable {
  private api?: GitAPI;
  private readonly repos = new Map<string, GitRepository>();
  private readonly apiRepos = new Map<string, GitApiRepository>();
  private readonly signatures = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  private currentKey?: string;

  readonly cli = new GitCli();

  private readonly _onDidChangeRepositories = new vscode.EventEmitter<void>();
  readonly onDidChangeRepositories = this._onDidChangeRepositories.event;
  private readonly _onDidChangeCurrent = new vscode.EventEmitter<GitRepository | undefined>();
  readonly onDidChangeCurrent = this._onDidChangeCurrent.event;
  /** Fires when refs/HEAD/in-progress operation of a repository changed. */
  private readonly _onDidChangeRepository = new vscode.EventEmitter<GitRepository>();
  readonly onDidChangeRepository = this._onDidChangeRepository.event;

  constructor(private readonly context: vscode.ExtensionContext, output: vscode.LogOutputChannel) {
    this.cli.onLog = line => output.trace(line);
    this.currentKey = context.workspaceState.get<string>(CURRENT_KEY);
  }

  async initialize(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    try {
      const exports = extension ? (extension.isActive ? extension.exports : await extension.activate()) : undefined;
      if (exports?.enabled) this.api = exports.getAPI(1);
    } catch {
      this.api = undefined;
    }

    if (this.api) {
      if (this.api.git.path) this.cli.gitPath = this.api.git.path;
      this.disposables.push(
        this.api.onDidOpenRepository(r => this.addApiRepository(r)),
        this.api.onDidCloseRepository(r => this.removeRepository(r.rootUri.fsPath)),
      );
      for (const r of this.api.repositories) this.addApiRepository(r);
    } else {
      await this.discoverWithoutApi();
    }
    this.ensureCurrent();
  }

  private async discoverWithoutApi(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const root = (await this.cli.exec(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim();
        if (root && !this.repos.has(key(root))) this.repos.set(key(root), new GitRepository(path.normalize(root), this.cli));
      } catch {
        // not a repository
      }
    }
    this._onDidChangeRepositories.fire();
  }

  private addApiRepository(apiRepo: GitApiRepository): void {
    const root = apiRepo.rootUri.fsPath;
    const k = key(root);
    if (!this.repos.has(k)) this.repos.set(k, new GitRepository(root, this.cli));
    this.apiRepos.set(k, apiRepo);
    this.disposables.push(apiRepo.state.onDidChange(() => this.scheduleCheck(k)));
    this._onDidChangeRepositories.fire();
    this.ensureCurrent();
  }

  private removeRepository(root: string): void {
    const k = key(root);
    this.repos.delete(k);
    this.apiRepos.delete(k);
    this.signatures.delete(k);
    this._onDidChangeRepositories.fire();
    if (this.currentKey === k) {
      this.currentKey = undefined;
      this.ensureCurrent();
    }
  }

  private ensureCurrent(): void {
    if (this.currentKey && this.repos.has(this.currentKey)) {
      return;
    }
    const previous = this.currentKey;
    const active = vscode.window.activeTextEditor?.document.uri;
    let candidate: string | undefined;
    if (active?.scheme === 'file') {
      const file = key(active.fsPath);
      candidate = [...this.repos.keys()].filter(k => file.startsWith(k + path.sep)).sort((a, b) => b.length - a.length)[0];
    }
    candidate ??= [...this.repos.keys()].sort((a, b) => a.length - b.length)[0];
    this.currentKey = candidate;
    if (candidate !== previous) this._onDidChangeCurrent.fire(this.current);
  }

  private scheduleCheck(k: string): void {
    clearTimeout(this.timers.get(k));
    this.timers.set(k, setTimeout(() => void this.check(k), 400));
  }

  private async check(k: string, force = false): Promise<void> {
    const repo = this.repos.get(k);
    if (!repo) return;
    const signature = await repo.signature().catch(() => '');
    if (!force && this.signatures.get(k) === signature) return;
    this.signatures.set(k, signature);
    this._onDidChangeRepository.fire(repo);
  }

  get current(): GitRepository | undefined {
    return this.currentKey ? this.repos.get(this.currentKey) : undefined;
  }

  get hasGitApi(): boolean {
    return !!this.api;
  }

  list(): GitRepository[] {
    return [...this.repos.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  setCurrent(root: string): void {
    const k = key(root);
    if (!this.repos.has(k)) this.repos.set(k, new GitRepository(root, this.cli));
    if (this.currentKey === k) return;
    this.currentKey = k;
    void this.context.workspaceState.update(CURRENT_KEY, k);
    this._onDidChangeCurrent.fire(this.current);
  }

  apiRepository(repo: GitRepository): GitApiRepository | undefined {
    return this.apiRepos.get(key(repo.root));
  }

  /** Forces listeners to reload the given (or current) repository. */
  async refresh(repo = this.current): Promise<void> {
    if (!repo) return;
    await this.check(key(repo.root), true);
    // Keep the built-in Source Control view in sync after our CLI operations.
    void this.apiRepository(repo)?.status().catch(() => undefined);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    vscode.Disposable.from(...this.disposables).dispose();
    this._onDidChangeRepositories.dispose();
    this._onDidChangeCurrent.dispose();
    this._onDidChangeRepository.dispose();
  }
}
