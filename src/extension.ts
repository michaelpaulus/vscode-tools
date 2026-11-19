import * as vscode from 'vscode';
import { Commands } from './commands';
import { RevisionContentProvider, SCHEME } from './diff';
import { GitRepository } from './git/repository';
import { RepoManager } from './repoManager';
import { FileHistoryPanels } from './views/fileHistoryPanel';
import { HistoryPanel } from './views/historyPanel';
import { RefsModel } from './views/refsModel';

export interface ExtensionApi {
  manager: RepoManager;
  refs: RefsModel;
  history: HistoryPanel;
  fileHistory: FileHistoryPanels;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = vscode.window.createOutputChannel('Git Repository', { log: true });
  const manager = new RepoManager(context, output);
  const refs = new RefsModel(manager);
  const history = new HistoryPanel(context, manager, refs);
  const fileHistory = new FileHistoryPanels(context, manager);

  const repoFor = (root: string) => manager.list().find(r => r.root === root) ?? new GitRepository(root, manager.cli);

  context.subscriptions.push(
    output,
    manager,
    refs,
    history,
    fileHistory,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(repoFor)),
    ...new Commands(manager, refs, history, fileHistory, output).register(),
  );

  await manager.initialize();
  return { manager, refs, history, fileHistory };
}

export function deactivate(): void {}
