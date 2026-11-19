# Git Repository Window for VS Code

A Visual Studio–style **Git Repository** window for VS Code: one editor tab with a branches tree on the left (branches, remotes, tags, stashes, worktrees, submodules), the commit graph with incoming/outgoing history in the middle, and commit details below.

## Features

Open it with `Git Repository: Open Git Repository`, `Ctrl+0 Ctrl+R`, or the button in the Source Control title bar.

**Branches pane** (left side of the window; resize with the splitter, hide with the toolbar toggle)
- Local branches grouped into folders by `/`, the current branch on top in bold, ahead/behind counts, and branches checked out in other worktrees
- Remotes with their branches, tags (newest first), stashes, linked worktrees, submodules
- Click a ref to show its history (the displayed ref is highlighted); double-click a branch to check it out; hover for quick actions; right-click for every operation
- Expand a stash to see its files (untracked files included); click one to diff it in VS Code's built-in diff editor
- Filter box (or just start typing in the tree) narrows every group and highlights matches; `Filter Branches` focuses it from the Command Palette
- Keyboard: arrows to move / expand / collapse, Enter to open, Space to toggle

**History**
- Commit graph with lane colours from the theme's SCM graph palette
- *Incoming* (upstream commits not yet pulled) and *Local History* (with outgoing count) sections, like Visual Studio
- Toggles: all branches, remote branches, tags, first-parent only, details pane
- Filter history by message, author or commit ID
- Ref badges (local + in-sync remote merged into one badge); right-click a badge for branch actions, double-click to view its history
- Commit details pane: author/committer, parents (click to navigate), full message, changed files; click a file to diff it against the parent
- Banner with *Continue / Abort* while a merge, rebase, cherry-pick or revert is in progress
- Keyboard: arrows / Page Up / Page Down / Home / End, `Ctrl+C` copies the selected commit ID

**Operations**
| Area | Commands |
| --- | --- |
| Branches | Checkout (offers stash or discard when local changes block it), new branch from branch/tag/commit, merge (ff / no-ff / squash / ff-only), rebase, rename, delete (with force for unmerged), delete remote branch, push / publish, set / unset upstream |
| Remote branches | Checkout as tracking branch, new branch, merge, rebase, delete |
| Tags | Checkout (detached), new branch, create (lightweight or annotated), push, delete locally or on a remote |
| Commits | Checkout (detached), new branch, new tag, cherry-pick, revert, reset (soft / mixed / hard), amend message or staged changes (HEAD only), copy ID / message |
| Files | Compare with previous, compare with working tree, open file at revision, open working file, copy path |
| Stashes | Stash all (with untracked), stash all but keep staged, stash staged only (each with an optional message), apply, pop (the stash is kept if it conflicts), delete, delete all, new branch from stash; for stash files: compare with working tree, open working file |
| Remote | Fetch (optionally prune), pull, push, sync |
| Worktrees | New worktree from a branch / remote branch / tag or a new branch, open (new or current window), lock / unlock, remove (with force), prune |
| Submodules | Add, open, update, update all (recursive), sync URL, deinitialize |

Network operations go through VS Code's built-in Git extension so your existing credentials work; everything else uses the `git` CLI the Git extension is configured with. Executed commands are logged to the **Git Repository** output channel (trace level).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitRepository.pageSize` | `400` | Commits loaded per page (more load on scroll) |
| `gitRepository.checkoutNewBranch` | `true` | Check out newly created branches |
| `gitRepository.fetchOnOpen` | `false` | Fetch when the history window opens |
| `gitRepository.dateFormat` | `locale` | `locale`, `iso` or `relative` |

## Development

```powershell
npm install
npm run build          # bundle extension + webview into dist/
npm run watch          # rebuild on change
npm run typecheck
npm test               # unit tests (parsers, graph, git layer against temp repos)
npm run test:integration   # launches VS Code and drives the commands against a fixture repo
```

Press `F5` to launch an Extension Development Host. To install locally:

```powershell
npm run package
code --install-extension git-repository-window-0.1.0.vsix
```

### Releasing

CI (`.github/workflows/ci.yml`) runs the typecheck, unit tests and integration tests on Ubuntu and Windows for every push to `main` and every pull request, then uploads the VSIX as a build artifact.

To release:

1. Update `version` in `package.json` (patch for fixes, minor for features, major for breaking changes) and move the `Unreleased` notes in `CHANGELOG.md` under the new version.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. `.github/workflows/release.yml` re-runs CI, checks the tag matches `package.json`, publishes to the Visual Studio Marketplace and creates a GitHub release with the VSIX attached.

Publishing uses Marketplace **Trusted Publishing** (GitHub OIDC), so no token is stored in the repository. One-time setup: on the [publisher management page](https://marketplace.visualstudio.com/manage), open the `michaelpaulus` publisher → **Trusted Publishing** → create a policy with owner `michaelpaulus`, repository `vscode-tools`, workflow `release.yml` and no environment.

### Layout

- `src/git/` – git CLI wrapper, output parsers and `GitRepository` (no `vscode` dependency, unit-tested)
- `src/shared/` – graph lane algorithm and the extension ↔ webview message protocol
- `src/views/` – branches model (loads refs and shapes the tree) and the Git Repository webview panel
- `src/commands.ts` – every command, using native quick picks, input boxes and confirmations
- `webview/` – window UI (branches pane, virtualised history grid, SVG graph, details pane), styled with VS Code theme variables and codicons
