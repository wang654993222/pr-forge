import { ErrorCode, error } from '../error-codes.js';
import { execSync } from 'node:child_process';

function escapeShellArg(arg) {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

function sanitizePath(p) {
  if (typeof p !== 'string' || p.includes('..') || p.startsWith('/')) {
    return false;
  }
  return true;
}

async function commit_and_push(params, gitOrExec, platform) {
  const git = gitOrExec || { execSync };
  const { message, pr_number, branch, files } = params;

  if (!message || typeof message !== 'string' || message.trim() === '') {
    return error('NO_CHANGES');
  }

  let targetBranch = branch;

  if (!targetBranch && pr_number && platform) {
    try {
      const pr = await platform.getPR(pr_number);
      targetBranch = pr.head_ref;
    } catch (e) {
      return error('PR_NOT_FOUND');
    }
  }

  if (!targetBranch) {
    return error('BRANCH_MISMATCH');
  }

  try {
    git.execSync('git status --porcelain');
  } catch {
    return error('DIRTY_WORKTREE');
  }

  const statusResult = git.execSync('git status --porcelain').toString().trim();
  if (!statusResult) {
    return error('NO_CHANGES');
  }

  try {
    // Checkout target branch first to avoid detached HEAD
    try {
      git.execSync(`git checkout ${escapeShellArg(targetBranch)}`);
    } catch {
      // Branch might not exist locally, try to create from origin
      try {
        git.execSync(`git checkout -b ${escapeShellArg(targetBranch)} origin/${escapeShellArg(targetBranch)}`);
      } catch {
        return error('BRANCH_MISMATCH');
      }
    }

    if (files && files.length > 0) {
      for (const f of files) {
        if (!sanitizePath(f)) {
          return error('INVALID_PATH');
        }
      }
      for (const f of files) {
        git.execSync(`git add -- ${escapeShellArg(f)}`);
      }
    } else {
      git.execSync('git add -A');
    }
    git.execSync(`git commit -m ${escapeShellArg(message)}`);
    git.execSync(`git push origin ${escapeShellArg(targetBranch)}`);
    return { ok: true, branch: targetBranch };
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
