import * as vscode from 'vscode';
import { Commands } from './commands';
import { RevisionContentProvider, SCHEME } from './diff';
import { GitRepository } from './git/repository';
import { RepoManager } from './repoManager';
import { HistoryPanel } from './views/historyPanel';
import { RefsTreeProvider, TreeNode } from './views/refsTree';

export interface ExtensionApi {
  manager: RepoManager;
  tree: RefsTreeProvider;
  history: HistoryPanel;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const output = vscode.window.createOutputChannel('Git Repository', { log: true });
  const manager = new RepoManager(context, output);
  const tree = new RefsTreeProvider(manager);
  const view = vscode.window.createTreeView<TreeNode>('gitRepository.refs', { treeDataProvider: tree, showCollapseAll: true });
  tree.attach(view);
  const history = new HistoryPanel(context, manager);

  const repoFor = (root: string) => manager.list().find(r => r.root === root) ?? new GitRepository(root, manager.cli);

  context.subscriptions.push(
    output,
    manager,
    tree,
    view,
    history,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionContentProvider(repoFor)),
    ...new Commands(manager, tree, history, output).register(),
  );

  void vscode.commands.executeCommand('setContext', 'gitRepository.treeFiltered', false);
  await manager.initialize();
  return { manager, tree, history };
}

export function deactivate(): void {}
