// Minimal subset of the built-in `vscode.git` extension API (see extensions/git/src/api/git.d.ts).
import type { Event, Uri } from 'vscode';

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
  readonly git: { readonly path: string };
  readonly repositories: GitApiRepository[];
  readonly onDidOpenRepository: Event<GitApiRepository>;
  readonly onDidCloseRepository: Event<GitApiRepository>;
}

export interface FetchOptions {
  remote?: string;
  ref?: string;
  all?: boolean;
  prune?: boolean;
  depth?: number;
}

export interface GitApiRepository {
  readonly rootUri: Uri;
  readonly state: { readonly onDidChange: Event<void> };
  fetch(options?: FetchOptions): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  status(): Promise<void>;
}
