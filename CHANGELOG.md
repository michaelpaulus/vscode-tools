# Changelog

All notable changes to this extension are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- The branches tree now lives inside the Git Repository window as a resizable left pane, like Visual Studio, instead of a separate activity-bar view. It has its own filter box with match highlighting, hover actions, and the same context menus. Double-click a branch to check it out.

## [0.1.0] - 2026-11-19

### Added
- Branches / Tags tree: local branches grouped by folder, remotes, tags, stashes, worktrees and submodules, with filtering and repository switching.
- History window with commit graph, Incoming / Local History sections, ref badges and a commit details pane.
- Branch, tag, commit, file, remote, worktree and submodule operations.
- Stashes: stash all / keep staged / staged only, apply, pop, delete, delete all, new branch from stash, and diffs for stashed files.
- Continue / Abort for in-progress merge, rebase, cherry-pick and revert.
