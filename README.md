# worktree-switch

VSCode extension: branch = worktree = window. A Git worktree is a separate checkout of the repo in its own folder, so every branch gets its own window.

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

Point `worktreeSwitch.setup` at a command that runs in each new worktree before its window opens. Put it in the repo's `.vscode/settings.json` to share it with everyone:

```jsonc
{
  "worktreeSwitch.setup": "yarn install && bash dev/setup.sh"
}
```

Empty by default. It runs in your shell with these variables set:

- `$WORKTREE_PATH` — worktree path
- `$WORKTREE_MAIN` — original repo root
- `$WORKTREE_BRANCH` — branch name

If it fails, you'll see the error and the window still opens.
