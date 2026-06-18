# worktree-switch

VS Code extension: branch = worktree = window. Each branch lives in its own Git worktree and opens in a dedicated VS Code window.

## Install

From the repo root:

```
cp -r . ~/.vscode/extensions/worktree-switch
```

Reload VS Code.

## Use

`cmd+shift+o` — pick a branch (or type a new name to create one). The default branch opens the original repo directory; any other branch opens in its own worktree — new window on first open, same window on return. 

## Per-repo setup: `setup-worktree.sh`

When a worktree is first created, the extension looks for `setup-worktree.sh` in the original repo (the cloned directory, not the worktree), in order: root → `dev/` → `scripts/` → `tools/` → `contrib/`. If found, runs it inside the new worktree before opening. Output streams to the "Worktree Switch" output channel.

Use it for per-branch setup (`yarn install`, `uv sync`, etc.) rather than symlinking `node_modules`/`.venv`, which go stale when dependencies differ across branches.

Variables passed to the script:

- `$1` / `$WORKTREE_PATH` — worktree path (positional arg and env var, same value)
- `$WORKTREE_MAIN` — original repo root
- `$WORKTREE_BRANCH` — branch name

## Todo 

- Rename "Switch to" to something better, since we now open a new window each time