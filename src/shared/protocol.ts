// Messages and data shapes shared between the extension host and the history webview.

export type RefType = 'branch' | 'remote' | 'tag' | 'head';

export interface RefBadge {
  type: RefType;
  /** Short name, e.g. `main`, `origin/main`, `v1.0`. */
  name: string;
  /** Full ref, e.g. `refs/heads/main`. */
  fullName: string;
  isCurrent?: boolean;
}

export interface CommitRow {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
  refs: RefBadge[];
}

export interface CommitFile {
  /** Single letter status: A, M, D, R, C, T, U. */
  status: string;
  path: string;
  oldPath?: string;
}

export interface CommitDetails extends CommitRow {
  committer: string;
  committerEmail: string;
  committerDate: string;
  body: string;
  files: CommitFile[];
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface HistoryOptions {
  /** `current` shows the selected ref (plus its upstream); `all` shows every local/remote branch. */
  mode: 'current' | 'all';
  showRemotes: boolean;
  showTags: boolean;
  firstParent: boolean;
}

export interface HistoryState {
  repoName: string;
  repoRoot: string;
  /** Short name of the ref being displayed (branch, tag, remote branch or short sha). */
  refLabel: string;
  refType: RefType | 'commit';
  /** Full name of the displayed ref (`refs/heads/main`), or undefined when showing HEAD. */
  refFull?: string;
  headLabel: string;
  headHash?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  operation?: GitOperation;
  hasRemotes: boolean;
  options: HistoryOptions;
  filter: string;
  dateFormat: 'locale' | 'iso' | 'relative';
}

export interface HistoryData {
  /** Commits on the upstream that are not on the displayed ref; `undefined` when not applicable. */
  incoming?: CommitRow[];
  commits: CommitRow[];
  hasMore: boolean;
  /** Hashes of commits on the displayed ref that are not on its upstream. */
  outgoing: string[];
  /** Hashes reachable from the upstream but not from the displayed ref (only used in `all` mode markers). */
  incomingHashes: string[];
  isSearch: boolean;
}

/**
 * `data-vscode-context` of a node in the branches pane. `treeItem` drives the `webview/context`
 * menus; the other keys identify the object so commands can resolve it.
 */
export interface RefTreeContext {
  webviewSection: 'tree';
  treeItem: string;
  refFull?: string;
  stashHash?: string;
  worktreePath?: string;
  submodulePath?: string;
  filePath?: string;
  fileOldPath?: string;
  fileStatus?: string;
  untracked?: boolean;
}

export interface RefTreeAction {
  command: string;
  icon: string;
  title: string;
}

export interface RefTreeNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  /** Rendered bold (the checked-out branch). */
  emphasis?: boolean;
  /** Full ref name, used to highlight the ref whose history is shown. */
  refFull?: string;
  context: RefTreeContext;
  /** `undefined` for leaves. */
  children?: RefTreeNode[];
  /** Children are fetched on first expand (stash files). */
  lazy?: boolean;
  expanded?: boolean;
  /** Hover buttons. */
  actions?: RefTreeAction[];
  /** Command run on click / Enter, and on double-click. Receives `context`. */
  command?: string;
  dblCommand?: string;
  /** Not matched by the filter box (placeholders such as "No stashes"). */
  noFilter?: boolean;
}

export type ToWebview =
  | { type: 'tree'; nodes: RefTreeNode[]; root: string }
  | { type: 'treeChildren'; id: string; nodes: RefTreeNode[] }
  | { type: 'focusTreeFilter' }
  | { type: 'state'; state: HistoryState }
  | { type: 'history'; data: HistoryData; preserveSelection?: boolean }
  | { type: 'more'; commits: CommitRow[]; hasMore: boolean }
  | { type: 'details'; details: CommitDetails | undefined; hash: string }
  | { type: 'loading'; value: boolean }
  | { type: 'error'; message: string }
  | { type: 'select'; hash: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'treeChildren'; id: string; stashHash: string }
  | { type: 'selectCommit'; hash: string }
  | { type: 'loadMore' }
  | { type: 'setOption'; key: keyof HistoryOptions; value: unknown }
  | { type: 'filter'; text: string }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'openFile'; hash: string; file: CommitFile };
