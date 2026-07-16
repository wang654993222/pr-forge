import { ErrorCode, error } from '../error-codes.js';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const PLATFORM = platform();

// Escape a shell argument for platform-safe quoting.
// Unix: single-quote with embedded-quote escaping.
// Windows (cmd.exe): double-quote, escaping embedded double-quotes.
function escapeShellArg(arg) {
  if (PLATFORM === 'win32') {
    return '"' + String(arg).replace(/"/g, '\\"') + '"';
  }
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

// Auto-detect the default branch name (main/master) from git remote.
function getDefaultBranch(git) {
  try {
    const ref = git.execSync('git symbolic-ref refs/remotes/origin/HEAD').toString().trim();
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    // Fallback: try 'main' first, then 'master'.
    try {
      git.execSync('git rev-parse --verify origin/main');
      return 'main';
    } catch {
      try { git.execSync('git rev-parse --verify origin/master'); return 'master'; }
      catch { return 'main'; }
    }
  }
}

async function commit_and_push(params, gitOrExec, platform) {
  const git = gitOrExec || { execSync };
  const { message, pr_number, branch, files, reviewer, title } = params;

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return error('NO_CHANGES');
  }

  // Auto-detect branch
  let targetBranch = branch;
  if (!targetBranch && pr_number && platform) {
    try {
      const pr = await platform.getPR(pr_number);
      targetBranch = pr.head_ref;
    } catch {
      return error('PR_NOT_FOUND');
    }
  }
  if (!targetBranch) {
    try {
      targetBranch = git.execSync('git branch --show-current').toString().trim();
    } catch {
      return error('BRANCH_MISMATCH');
    }
  }
  if (!targetBranch || targetBranch === 'main' || targetBranch === 'master') {
    return error('BRANCH_MISMATCH');
  }

  // Check if there are changes to commit
  try {
    git.execSync('git status --porcelain');
  } catch {
    return error('DIRTY_WORKTREE');
  }

  const statusResult = git.execSync('git status --porcelain').toString().trim();
  const hasChanges = statusResult.length > 0;

  try {
    // Ensure we are on the target branch
    try {
      git.execSync(`git checkout ${escapeShellArg(targetBranch)}`);
    } catch {
      try {
        git.execSync(`git checkout -b ${escapeShellArg(targetBranch)} origin/${escapeShellArg(targetBranch)}`);
      } catch {
        return error('BRANCH_MISMATCH');
      }
    }

    // Commit only if there are changes
    if (hasChanges) {
      if (files && files.length > 0) {
        for (const f of files) {
          git.execSync(`git add -- ${escapeShellArg(f)}`);
        }
      } else {
        git.execSync('git add -A');
      }
      try {
        // Windows cmd.exe cannot handle multi-line -m; use multiple -m flags.
        if (PLATFORM === 'win32' && message.includes('\n')) {
          const lines = message.split('\n');
          const args = lines.map(l => `-m ${escapeShellArg(l)}`).join(' ');
          git.execSync(`git commit ${args}`);
        } else {
          git.execSync(`git commit -m ${escapeShellArg(message)}`);
        }
      } catch (e) {
        const msg = (e.stderr?.toString() || '') + (e.stdout?.toString() || '');
        if (!msg.includes('nothing to commit') && !msg.includes('nothing added to commit')) {
          throw e;
        }
      }
    }

    git.execSync(`git push origin ${escapeShellArg(targetBranch)}`);

    // Auto-create PR if none exists for this branch
    let resolvedPrNumber = pr_number;
    if (!resolvedPrNumber && platform) {
      try {
        const head = targetBranch;
        const prs = await platform.listPRs('open', head);
        if (prs.length > 0) {
          resolvedPrNumber = prs[0].number;
        } else {
          const prTitle = title || message.split('\n')[0].slice(0, 80);
          const prBody = reviewer
            ? `<!-- pr-forge-reviewer: ${reviewer} -->\n\n${message}`
            : message;
          const base = getDefaultBranch(git);
          const newPr = await platform.createPR(prTitle, targetBranch, base, prBody);
          resolvedPrNumber = newPr.number;
        }
      } catch (err) {
        console.error('pr-forge: PR creation failed:', err.message);
      }
    }

    return { ok: true, branch: targetBranch, pr_number: resolvedPrNumber || null };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: ErrorCode.GIT_ERROR.code,
        message: e.stderr?.toString() || e.message,
        recovery: ErrorCode.GIT_ERROR.recovery,
      },
    };
  }
}

export { commit_and_push };
