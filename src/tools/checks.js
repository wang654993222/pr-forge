import { error } from '../error-codes.js';

async function run_pr_checks(params, config, platform, context, gitExec) {
  const git = gitExec || { execSync: () => { throw new Error('git not available'); } };
  const { pr_number, phase: targetPhase } = params;

  if (!config) {
    return error('NO_CONFIG');
  }

  if (context.verifyConfig && !context.verifyConfig()) {
    return error('CONFIG_MODIFIED');
  }

  // Check dirty worktree
  if (git.execSync) {
    try {
      const status = git.execSync('git status --porcelain').toString().trim();
      if (status) {
        return error('DIRTY_WORKTREE');
      }
    } catch {
      return error('GIT_ERROR');
    }
  }

  if (context.acquireLock && !context.acquireLock()) {
    return error('LOCKED');
  }

  const origSha = git.execSync('git rev-parse HEAD').toString().trim();

  try {
    const pr = await platform.getPR(pr_number);
    const prHeadSha = pr.head_sha;

    // Fetch and checkout PR branch
    git.execSync(`git fetch origin +pull/${pr_number}/head:pr-${pr_number}`);
    git.execSync(`git checkout pr-${pr_number}`);

    const DOC_EXTENSIONS = new Set([
      '.md', '.txt', '.rst', '.adoc', '.markdown', '.mdown',
    ]);
    const DOC_ONLY_GLOBS = [
      'README*', 'CHANGELOG*', 'CONTRIBUTING*', 'LICENSE*',
    ];

    function hasCodeChanges() {
      try {
        const changedFiles = git.execSync(
          `git diff --name-only origin/${pr.base_ref}...HEAD`
        ).toString().trim();
        if (!changedFiles) return false;
        return changedFiles.split('\n').some((f) => {
          const name = f.replace(/^.*[/\\]/, '').toLowerCase();
          if (DOC_EXTENSIONS.has(f.substring(f.lastIndexOf('.')).toLowerCase())) return false;
          if (DOC_ONLY_GLOBS.some((g) => {
            const pat = g.toLowerCase().replace(/\*/g, '.*');
            return new RegExp('^' + pat + '$').test(name);
          })) return false;
          return true;
        });
      } catch {
        return true; // if we can't determine, run checks
      }
    }

    const phases = config.phases.filter(
      (p) => !targetPhase || p.id === targetPhase
    );

    const results = {};
    const executed = [];
    let codeUpdated = false;
    const shouldRunChecks = hasCodeChanges();

    for (const phase of phases) {
      executed.push(phase.id);
      const startTime = Date.now();

      if (!shouldRunChecks) {
        const summary = '跳过: 仅文档变更，无需运行代码检查';
        results[phase.id] = {
          conclusion: 'success',
          exit_code: 0,
          duration_ms: 0,
          output_summary: summary,
        };
        try {
          await platform.createCheckRun(prHeadSha, `pr-forge/${phase.id}`, {
            conclusion: 'success',
            output: { title: phase.name || phase.id, summary },
          });
        } catch {}
        continue;
      }

      try {
        const output = git.execSync(phase.check, {
          timeout: (phase.timeout || config.timeout || 300) * 1000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        results[phase.id] = {
          conclusion: 'success',
          exit_code: 0,
          duration_ms: Date.now() - startTime,
          output_summary: output.toString().trim().slice(0, 500),
        };
      } catch (e) {
        results[phase.id] = {
          conclusion: 'failure',
          exit_code: e.status || 1,
          duration_ms: Date.now() - startTime,
          output_summary: (e.stderr || e.stdout || e.message || '').toString().trim().slice(0, 500),
        };
      }

      // Write Check Run for each phase
      try {
        await platform.createCheckRun(prHeadSha, `pr-forge/${phase.id}`, {
          conclusion: results[phase.id].conclusion,
          output: {
            title: phase.name || phase.id,
            summary: results[phase.id].output_summary,
          },
        });
      } catch {
        // Check Run write failure is non-fatal — result is still returned inline
      }
    }

    // Check if code was updated during execution
    try {
      const currentSha = git.execSync('git rev-parse pr-' + pr_number).toString().trim();
      if (currentSha !== prHeadSha) {
        codeUpdated = true;
      }
    } catch {
      // ignore fetch errors for SHA check
    }

    // Checkout back to original SHA
    try {
      git.execSync(`git checkout ${origSha}`);
    } catch {
      // If checkout fails, at least we're not in a worse state
    }

    const conclusions = Object.values(results).map((r) => r.conclusion);
    let aggregate = 'success';
    if (conclusions.some((c) => c === 'failure')) aggregate = 'failure';
    else if (conclusions.some((c) => c !== 'success')) aggregate = 'neutral';

    const warnings = [];
    if (codeUpdated) {
      warnings.push('code_updated_during_check');
    }

    return {
      ok: true,
      executed,
      results,
      aggregate,
      warnings,
      next_suggestion: aggregate === 'failure'
        ? `修复失败阶段后重跑 run_pr_checks`
        : null,
    };
  } catch (e) {
    return error(e.code || 'GIT_ERROR');
  } finally {
    if (context.releaseLock) {
      context.releaseLock();
    }
  }
}

export { run_pr_checks };
