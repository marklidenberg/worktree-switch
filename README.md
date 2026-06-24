# worktree-switch

A simple VSCode extension that opens each Git worktree in its own window, and runs a setup command when a worktree is first created.

## Install

Not on the Marketplace — clone into your extensions folder:

```
git clone https://github.com/marklidenberg/worktree-switch.git ~/.vscode/extensions/worktree-switch
```

Reload VSCode.

## Use

Run **Worktree: Switch Branch** (`cmd+shift+o`) — pick a branch, or type a new name to create one.

The default branch (usually `main`) opens the repo itself. Any other branch opens in its own worktree.

## Setup per worktree

Point `worktreeSwitch.setupWorktreeCommand` at a command that runs in each new worktree before its window opens. Put it in the repo's `.vscode/settings.json` to share it with everyone:

```jsonc
{
  "worktreeSwitch.setupWorktreeCommand": "yarn install && bash dev/setup.sh"
}
```

Empty by default. It runs in your shell with these variables set:

- `$WORKTREE_PATH` — worktree path
- `$WORKTREE_MAIN` — original repo root
- `$WORKTREE_BRANCH` — branch name

If it fails, you'll see the error and the window won't open.
