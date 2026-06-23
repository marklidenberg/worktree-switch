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

## Per-repo setup: `worktreeSwitch.setup`

When a worktree is first created, the extension runs the command in the `worktreeSwitch.setup` setting inside the new worktree before opening it. Leave it empty (the default) to skip setup.

Set it in the repo's `.vscode/settings.json` so it's shared with everyone working on the repo:

```jsonc
{
  "worktreeSwitch.setup": "yarn install && bash dev/setup.sh"
}
```

Use it for per-branch setup (`yarn install`, `uv sync`, etc.) rather than symlinking `node_modules`/`.venv`, which go stale when dependencies differ across branches.

The command runs in the platform's default shell, with the new worktree as the working directory. A non-zero exit is surfaced but doesn't block opening the worktree. Environment variables passed to it:

- `$WORKTREE_PATH` — worktree path
- `$WORKTREE_MAIN` — original repo root
- `$WORKTREE_BRANCH` — branch name
