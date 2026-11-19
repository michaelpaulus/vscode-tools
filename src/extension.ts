import * as vscode from 'vscode';
import { Commands } from './commands';
import { RevisionContentProvider, SCHEME } from './diff';
import { GitRepository } from './git/repository';
import { RepoManager } from './repoManager';
import { HistoryPanel } from './views/historyPanel';
import { RefsModel } from './views/refsModel';

export interface ExtensionApi {
  manager: RepoManager;
  refs: RefsModel;
  history: HistoryPanel;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = vscode.window.createOutputChannel('Git Repository', { log: true });
  const manager = new RepoManager(context, output);
  const refs = new RefsModel(manager);
  const history = new HistoryPanel(context, manager, refs);

  const repoFor = (root: string) => manager.list().find(r => r.root === root) ?? new GitRepository(root, manager.cli);

  context.subscriptions.push(
    output,
    manager,
    refs,
    history,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(repoFor)),
    ...new Commands(manager, refs, history, output).register(),
  );

  await manager.initialize();
  return { manager, refs, history };
}

export function deactivate(): void {}
