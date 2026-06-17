const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

// - Run git, returning trimmed stdout. `noHooks` disables repo hooks for this call.

function git(args, cwd, noHooks) {
  const full = noHooks ? ['-c', 'core.hooksPath=/dev/null', ...args] : args;
  return cp.execFileSync('git', full, { cwd, encoding: 'utf8' }).trim();
}

function refExists(ref, cwd) {
  try {
    git(['show-ref', '--verify', '--quiet', ref], cwd);
    return true;
  } catch {
    return false;
  }
}

// - Searchable branch picker. Typing a name that no branch matches surfaces a
//   "Create branch …" item. Resolves to the chosen branch name, or undefined.

function pickBranch(names, def) {
  return new Promise((resolve) => {
    const base = names.map((n) => ({ label: n, branch: n }));
    const qp = vscode.window.createQuickPick();
    qp.title = 'Worktree: Switch Branch';
    qp.placeholder = 'Switch to a branch — or type a new name to create it';
    qp.items = base;
    qp.onDidChangeValue((value) => {
      const v = value.trim();
      qp.items = v && !names.includes(v)
        ? [{ label: `$(plus) Create branch "${v}"`, description: `from ${def}`, branch: v }, ...base]
        : base;
    });
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      resolve(sel ? sel.branch : undefined);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

async function switchBranch() {
  // - Find the repo and its main worktree root

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    vscode.window.showErrorMessage('Worktree: no folder is open');
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const cwd = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath) || folders[0].uri.fsPath;

  let root;
  try {
    const first = git(['worktree', 'list', '--porcelain'], cwd).split('\n').find((l) => l.startsWith('worktree '));
    root = first.slice('worktree '.length);
  } catch (e) {
    vscode.window.showErrorMessage('Worktree: not a git repository');
    return;
  }

  // - Resolve the default branch (origin/HEAD, falling back to main)

  let def = 'main';
  try {
    def = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root).replace(/^origin\//, '');
  } catch {}

  // - Collect branch names (local + remote, deduped, default first)

  const raw = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], root).split('\n');
  const names = new Set();
  for (let n of raw) {
    if (!n || n === 'origin' || n.endsWith('/HEAD')) continue;
    names.add(n.replace(/^origin\//, ''));
  }
  const items = [def, ...[...names].filter((n) => n !== def).sort()];

  const picked = await pickBranch(items, def);
  if (!picked) return;

  // - Default branch -> open the main repo folder

  if (picked === def) {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), { forceNewWindow: false });
    return;
  }

  // - Ensure .worktrees/ with a self-ignoring .gitignore

  const wtDir = path.join(root, '.worktrees');
  fs.mkdirSync(wtDir, { recursive: true });
  const gitignore = path.join(wtDir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');

  // - Create the worktree if missing (hooks disabled to avoid the repo's yarnhook failure)

  const target = path.join(wtDir, picked);
  if (!fs.existsSync(target)) {
    // - If the picked branch is checked out in the main repo, it can't also be a
    //   worktree. Offer to free it by switching the main repo to the default branch.

    let rootBranch;
    try {
      rootBranch = git(['symbolic-ref', '--short', 'HEAD'], root);
    } catch {}
    if (rootBranch === picked) {
      const switchAction = `Switch main repo to ${def}`;
      const choice = await vscode.window.showWarningMessage(
        `Branch "${picked}" is checked out in the main repo, so it can't also be opened as a worktree.`,
        { modal: true, detail: `Switch the main repo to "${def}" to free the branch?` },
        switchAction,
      );
      if (choice !== switchAction) return;
      try {
        git(['checkout', def], root, true);
      } catch (e) {
        vscode.window.showErrorMessage('Worktree: could not switch main repo — ' + (e && e.message ? e.message : String(e)));
        return;
      }
    }

    try {
      git(['worktree', 'prune'], root, true);
      if (refExists(`refs/heads/${picked}`, root) || refExists(`refs/remotes/origin/${picked}`, root)) {
        git(['worktree', 'add', target, picked], root, true);
      } else {
        let base = `origin/${def}`;
        if (!refExists(`refs/remotes/${base}`, root)) base = def;
        git(['worktree', 'add', '-b', picked, target, base], root, true);
      }
    } catch (e) {
      if (!fs.existsSync(target)) {
        vscode.window.showErrorMessage('Worktree: ' + (e && e.message ? e.message : String(e)));
        return;
      }
    }
  }

  // - Open the worktree

  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: false });
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('worktreeSwitch.switch', switchBranch));
}

function deactivate() {}

module.exports = { activate, deactivate };
