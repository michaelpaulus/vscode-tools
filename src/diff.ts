import * as path from 'node:path';
import * as vscode from 'vscode';
import { EMPTY_TREE, GitRepository } from './git/repository';
import type { Stash } from './git/parsers';
import type { CommitFile } from './shared/protocol';

export const SCHEME = 'gitrepo';

interface RevQuery {
  root: string;
  path: string;
  ref: string;
}

/** Builds a read-only URI for `relPath` at `ref` (empty `ref` = file does not exist on that side). */
export function toRevisionUri(root: string, relPath: string, ref: string): vscode.Uri {
  const file = vscode.Uri.file(path.join(root, relPath));
  const query: RevQuery = { root, path: relPath, ref };
  return file.with({ scheme: SCHEME, query: JSON.stringify(query) });
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly repoFor: (root: string) => GitRepository) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = JSON.parse(uri.query) as RevQuery;
    const content = await this.repoFor(query.root).show(query.ref, query.path);
    return content.toString('utf8');
  }
}

const short = (ref: string | undefined) => (ref && ref !== EMPTY_TREE ? ref.slice(0, 8) : 'empty');

export async function openCommitFileDiff(repo: GitRepository, hash: string, parent: string | undefined, file: CommitFile): Promise<void> {
  const left = file.status === 'A' || !parent ? '' : parent;
  const right = file.status === 'D' ? '' : hash;
  const leftPath = file.oldPath ?? file.path;
  const name = path.basename(file.path);
  const title = file.oldPath
    ? `${path.basename(file.oldPath)} (${short(left)}) ↔ ${name} (${short(right)})`
    : `${name} (${short(left)}) ↔ (${short(right)})`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    toRevisionUri(repo.root, leftPath, left),
    toRevisionUri(repo.root, file.path, right),
    title,
    { preview: true },
  );
}

/** Diffs a file in a stash against the commit the stash was made on (untracked files diff against nothing). */
export async function openStashFileDiff(repo: GitRepository, stash: Stash, file: CommitFile & { untracked?: boolean }): Promise<void> {
  const right = file.status === 'D' ? '' : stashFileRef(stash, file);
  const left = file.untracked || file.status === 'A' ? '' : stash.parents[0] ?? '';
  const name = path.basename(file.path);
  await vscode.commands.executeCommand(
    'vscode.diff',
    toRevisionUri(repo.root, file.oldPath ?? file.path, left),
    toRevisionUri(repo.root, file.path, right),
    `${name} (${stash.ref})${file.untracked ? ' [untracked]' : ''}`,
    { preview: true },
  );
}

/** The commit holding a stashed file's content. */
export function stashFileRef(stash: Stash, file: { untracked?: boolean }): string {
  return file.untracked ? stash.parents[2] : stash.hash;
}

export async function openFileAtRevision(repo: GitRepository, hash: string, relPath: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(toRevisionUri(repo.root, relPath, hash));
  await vscode.window.showTextDocument(doc, { preview: true });
}

export async function compareWithWorkingTree(repo: GitRepository, hash: string, relPath: string, workingPath = relPath): Promise<void> {
  await vscode.commands.executeCommand(
    'vscode.diff',
    toRevisionUri(repo.root, relPath, hash),
    vscode.Uri.file(path.join(repo.root, workingPath)),
    `${path.basename(relPath)} (${short(hash)}) ↔ ${path.basename(workingPath)} (Working Tree)`,
    { preview: true },
  );
}

export interface FileVersion {
  hash: string;
  /** Path of the file in that commit. */
  path: string;
}

/** Diffs two committed versions of a file; each side is read at its own path so renames compare correctly. */
export async function compareFileVersions(repo: GitRepository, older: FileVersion, newer: FileVersion): Promise<void> {
  const left = `${path.basename(older.path)} (${short(older.hash)})`;
  const right = older.path === newer.path ? `(${short(newer.hash)})` : `${path.basename(newer.path)} (${short(newer.hash)})`;
  await vscode.commands.executeCommand(
    'vscode.diff',
    toRevisionUri(repo.root, older.path, older.hash),
    toRevisionUri(repo.root, newer.path, newer.hash),
    `${left} ↔ ${right}`,
    { preview: true },
  );
}
