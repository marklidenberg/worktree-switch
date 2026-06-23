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

// - Per-repo setup for a freshly created worktree. The `worktreeSwitch.setup`
//   setting holds a shell command (e.g. `yarn install`, or `bash dev/setup.sh`,
//   chained with `&&`); when set, it runs inside the new worktree to do per-repo
//   prep (installs, husky, venv sync, link skills-tree). Output streams live to the
//   "Worktree Switch" output channel under a progress notification; the worktree
//   path and branch are passed via WORKTREE_* env vars. Resolves to true on success
//   (or when no setup is configured) and false on failure; a failure surfaces an
//   error and the caller leaves the worktree unopened. Empty/unset skips setup.

let outputChannel;
function getOutput() {
  if (!outputChannel) outputChannel = vscode.window.createOutputChannel('Worktree Switch');
  return outputChannel;
}

function runSetupWorktree(root, target, branch) {
  const setup = (vscode.workspace.getConfiguration('worktreeSwitch', vscode.Uri.file(target)).get('setup') || '').trim();
  if (!setup) return Promise.resolve(true);

  const out = getOutput();
  out.clear();
  out.show(true);
  out.appendLine(`Preparing worktree "${branch}" — running: ${setup}`);
  out.appendLine('—'.repeat(60));

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Preparing worktree "${branch}"…`, cancellable: false },
    () => new Promise((resolve) => {
      const child = cp.spawn(setup, {
        cwd: target,
        shell: true,
        env: { ...process.env, WORKTREE_MAIN: root, WORKTREE_PATH: target, WORKTREE_BRANCH: branch },
      });
      child.stdout.on('data', (d) => out.append(d.toString()));
      child.stderr.on('data', (d) => out.append(d.toString()));
      child.on('error', (e) => {
        out.appendLine(`\n[error] ${e.message}`);
        vscode.window.showErrorMessage(`Worktree setup could not run: ${e.message}`);
        resolve(false);
      });
      child.on('close', (code) => {
        out.appendLine(`\n${'—'.repeat(60)}`);
        if (code === 0) {
          out.appendLine(`Worktree "${branch}" ready.`);
          resolve(true);
        } else {
          out.appendLine(`Worktree setup exited with code ${code}.`);
          vscode.window.showErrorMessage(`Worktree setup failed (exit ${code}). See "Worktree Switch" output.`);
          resolve(false);
        }
      });
    }),
  );
}

// - Validate a new branch name against git's ref-name rules (git-check-ref-format).
//   Returns a human-readable reason if invalid, or null if the name is allowed.

function validateBranchName(name) {
  if (!name) return 'Branch name cannot be empty';
  if (name.startsWith('-')) return 'Branch name cannot start with "-"';
  if (name === '@') return 'Branch name cannot be "@"';
  if (name.startsWith('/') || name.endsWith('/')) return 'Branch name cannot start or end with "/"';
  if (name.endsWith('.')) return 'Branch name cannot end with "."';
  if (name.includes('//')) return 'Branch name cannot contain "//"';
  if (name.includes('..')) return 'Branch name cannot contain ".."';
  if (name.includes('@{')) return 'Branch name cannot contain "@{"';
  if (/[ \t~^:?*\[\\\x00-\x1F\x7F]/.test(name)) return 'Branch name cannot contain spaces or any of: ~ ^ : ? * [ \\';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'No part of a branch name can start with "."';
    if (part.endsWith('.lock')) return 'No part of a branch name can end with ".lock"';
  }
  return null;
}

// - A branch name (which may contain "/", "@", etc.) becomes a single worktree
//   directory name. encodeFilename percent-encodes it into a safe, reversible,
//   mostly-readable name; decodeFilename inverts it. Beyond plain percent-encoding
//   we also guard Windows reserved device names (CON, COM1, …) and trailing dots,
//   so the same name is safe on macOS, Linux, and Windows.

const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

// - Percent-encode like Python's urllib.parse.quote(safe=''): keep A-Za-z0-9 and
//   _.-~ readable, encode everything else. encodeURIComponent leaves !*'() alone,
//   so encode those too.
function percentEncode(s) {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodeFilename(name) {
  if (name === '') return '%2E%2E%2E'; // sentinel for empty; no real input maps here
  let enc = percentEncode(name);
  const stem = enc.split('.', 1)[0];
  if (RESERVED_NAMES.has(stem.toUpperCase()) || enc === '.' || enc === '..') {
    // CON, CON.txt, '.', '..' -> escape the first char so the name is inert
    enc = '%' + enc.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0') + enc.slice(1);
  }
  if (enc.endsWith('.')) enc = enc.slice(0, -1) + '%2E'; // Windows strips trailing dots
  return enc;
}

function decodeFilename(name) {
  if (name === '%2E%2E%2E') return '';
  return decodeURIComponent(name);
}

// - The one picker. `buildModels()` returns the current branch rows (re-queryable
//   so the list can refresh after a delete); each row gets a trash button that
//   invokes `onDelete(model)` in place. Typing an unknown name surfaces a
//   "Create branch …" item, or a red error row for an invalid name (Enter ignored).
//   Resolves to the chosen branch name, or undefined.

function pickBranch(def, buildModels, onDelete) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.title = 'Worktree: Switch Branch';
    qp.placeholder = 'Switch to a branch, type a new name to create it, or click the trash icon to delete';

    let base = [];
    const render = () => {
      const v = qp.value.trim();
      if (!v || base.some((b) => b.branch === v)) {
        qp.title = 'Worktree: Switch Branch';
        qp.items = base;
        return;
      }
      const err = validateBranchName(v);
      if (err) {
        // - Make the invalid state unmistakable: surface the reason in the title,
        //   show only a red error row (alwaysShow so the filter can't hide it), and
        //   block Enter below.
        qp.title = `$(error) Invalid branch name — ${err}`;
        qp.items = [{ label: `$(error) "${v}" can't be used as a branch name`, description: err, alwaysShow: true, invalid: true }];
      } else {
        qp.title = 'Worktree: Switch Branch';
        qp.items = [{ label: `$(plus) Create branch "${v}"`, description: `from ${def}`, alwaysShow: true, branch: v }, ...base];
      }
    };
    const reload = () => {
      base = buildModels().map((m) => {
        const it = { label: m.branch, branch: m.branch, model: m };
        if (m.current) it.description = '$(check) current';
        else if (m.worktreePath) it.description = '$(folder) worktree';
        // - Trash button on every branch except the default (the main repo isn't deletable).
        if (m.branch !== def) it.buttons = [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete worktree & branch' }];
        return it;
      });
      render();
    };

    qp.onDidChangeValue(render);
    qp.onDidAccept(() => {
      const sel = qp.selectedItems[0];
      if (sel && sel.invalid) return; // keep the picker open; the error item explains why
      resolve(sel ? sel.branch : undefined);
      qp.hide();
    });
    qp.onDidTriggerItemButton(async (e) => {
      const model = e.item && e.item.model;
      if (!model) return;
      qp.busy = true;
      const result = await onDelete(model);
      qp.busy = false;
      if (result === 'window-closed') { resolve(undefined); qp.hide(); return; }
      reload(); // refresh the list in place
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });

    reload();
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

  const open = path.resolve(cwd);

  // - Branch rows for the picker (local + remote, deduped, default first), each
  //   annotated with its worktree path (if any) and whether it's the open window.

  const buildModels = () => {
    const raw = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], root).split('\n');
    const names = new Set();
    for (let n of raw) {
      if (!n || n === 'origin' || n.endsWith('/HEAD')) continue;
      names.add(n.replace(/^origin\//, ''));
    }
    const ordered = [def, ...[...names].filter((n) => n !== def).sort()];
    const wtByBranch = new Map();
    for (const e of listWorktrees(root)) if (e.branch) wtByBranch.set(e.branch, e.path);
    return ordered.map((b) => {
      const worktreePath = wtByBranch.get(b);
      return { branch: b, worktreePath, current: worktreePath ? path.resolve(worktreePath) === open : false };
    });
  };

  // - Trash-button handler: remove the branch's worktree (if any) and force-delete
  //   its local branch. Returns 'window-closed' if it deleted the open worktree.

  const onDelete = async (model) => {
    const branch = model.branch;
    const wt = listWorktrees(root).find((e) => e.branch === branch && path.resolve(e.path) !== path.resolve(root));
    const failures = [];
    let deletedCurrent = false;
    try {
      if (wt) {
        git(['worktree', 'remove', '--force', wt.path], root, true);
        if (path.resolve(wt.path) === open) deletedCurrent = true;
      }
      if (branch !== def && refExists(`refs/heads/${branch}`, root)) {
        try { git(['branch', '-D', branch], root, true); } catch (e) {
          failures.push(`branch ${branch}: ${e && e.message ? e.message.trim() : String(e)}`);
        }
      }
    } catch (e) {
      failures.push(`${branch}: ${e && e.message ? e.message.trim() : String(e)}`);
    }
    try { git(['worktree', 'prune'], root, true); } catch {}
    if (failures.length) vscode.window.showErrorMessage(`Worktree: delete failed — ${failures.join('; ')}`);
    if (deletedCurrent) {
      await vscode.commands.executeCommand('workbench.action.closeWindow');
      return 'window-closed';
    }
    return undefined;
  };

  const picked = await pickBranch(def, buildModels, onDelete);
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

  // - Prefix the worktree folder with the repo name (`<repo>__<branch>`) so its
  //   window title is distinguishable from same-named branches in other repos.
  //   The git branch itself stays unprefixed.

  const repoName = path.basename(root);
  const target = path.join(wtDir, `${repoName}__${encodeFilename(picked)}`);
  const created = !fs.existsSync(target);
  if (created) {
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
        git(['worktree', 'add', '--no-track', '-b', picked, target, base], root, true);
      }
    } catch (e) {
      if (!fs.existsSync(target)) {
        vscode.window.showErrorMessage('Worktree: ' + (e && e.message ? e.message : String(e)));
        return;
      }
    }
  }

  // - Run the configured `worktreeSwitch.setup` command for a freshly created
  //   worktree (per-repo setup like skills-tree linking, installs, etc.)

  // - If setup fails, leave the worktree unopened so the failure is unmistakable
  //   (the error is already surfaced). The worktree still exists; the next switch
  //   to this branch reuses it and opens without re-running setup.
  if (created && !(await runSetupWorktree(root, target, picked))) return;

  // - Open the worktree. A freshly created worktree opens in a NEW window (so the
  //   current one stays put); switching to an existing worktree reuses this window.

  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: created });
}

// - Parse `git worktree list --porcelain` into { path, branch?, bare?, detached? }.

function listWorktrees(root) {
  const out = git(['worktree', 'list', '--porcelain'], root);
  const entries = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice('worktree '.length) }; entries.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (cur && line === 'bare') cur.bare = true;
    else if (cur && line === 'detached') cur.detached = true;
  }
  return entries;
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('worktreeSwitch.switch', switchBranch));
}

function deactivate() {}

module.exports = { activate, deactivate };
