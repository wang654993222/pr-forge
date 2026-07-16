import { ErrorCode, error } from '../error-codes.js';
import { execSync } from 'node:child_process';

function escapeShellArg(arg) {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
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

  // Check if there are changes to commit (skip if clean)
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
      git.execSync(`git commit -m ${escapeShellArg(message)}`);
    }

    git.execSync(`git push origin ${escapeShellArg(targetBranch)}`);

    // Auto-create PR if none exists for this branch
    let resolvedPrNumber = pr_number;
    if (!resolvedPrNumber && platform) {
      try {
        const head = `${platform.owner}:${targetBranch}`;
        const prs = await platform.listPRs('open', head);
        if (prs.length > 0) {
          resolvedPrNumber = prs[0].number;
        } else {
          const prTitle = title || message.split('\n')[0].slice(0, 80);
          const prBody = reviewer
            ? `<!-- pr-forge-reviewer: ${reviewer} -->\n\n${message}`
            : message;
          const newPr = await platform.createPR(prTitle, targetBranch, 'main', prBody);
          resolvedPrNumber = newPr.number;
        }
      } catch {
        // PR creation is best-effort; push already succeeded
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
