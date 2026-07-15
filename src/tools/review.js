import { error } from '../error-codes.js';

const PR_FORGE_CHECK_RUN_PREFIX = 'pr-forge/';

function getPhaseCheckRuns(checkRuns) {
  const all = checkRuns?.check_runs || [];
  return {
    phases: all
      .filter((cr) => cr.name.startsWith(PR_FORGE_CHECK_RUN_PREFIX) && cr.name !== 'pr-forge/conclusion'),
    conclusion: all.find((cr) => cr.name === 'pr-forge/conclusion') || null,
  };
}

async function get_review_plan(params, platform, config) {
  const { pr_number } = params || {};

  if (!platform) {
    return {
      ok: true,
      pr: null,
      prerequisites: { config_exists: !!config, git_clean: true, token_valid: false },
      phases: [],
      conclusion_status: 'not_set',
      merge_ready: false,
      next_action: 'run_pr_checks',
      next_params: {},
      blocker: 'platform_not_available',
      blocker_resolution: '配置有效的 Git 远程仓库和 token',
    };
  }

  let pr;
  try {
    pr = await platform.getPR(pr_number);
  } catch (e) {
    return error(e.code || 'PR_NOT_FOUND');
  }

  const checkRuns = await platform.listCheckRuns(pr.head_sha);
  const { phases: phaseCheckRuns, conclusion: conclusionCheckRun } = getPhaseCheckRuns(checkRuns);

  const phases = (config?.phases || [{ id: 'default', name: '验证' }]).map((p) => {
    const cr = phaseCheckRuns.find((c) => c.name === `pr-forge/${p.id}`);
    return {
      id: p.id,
      name: p.name || p.id,
      check_run_status: cr?.status === 'completed' ? 'completed' : 'not_started',
      conclusion: cr?.conclusion || null,
    };
  });

  const allPhasesCompleted = phases.every((p) => p.check_run_status === 'completed');
  const allPhasesSuccess = phases.every((p) => p.conclusion === 'success');
  const conclusionDone = !!conclusionCheckRun;

  let next_action = 'run_pr_checks';
  let next_params = { pr_number };
  let merge_ready = false;

  if (!allPhasesCompleted) {
    next_action = 'run_pr_checks';
    const nextPhase = phases.find((p) => p.check_run_status !== 'completed');
    if (nextPhase) next_params = { pr_number, phase: nextPhase.id };
  } else if (allPhasesSuccess && !conclusionDone) {
    next_action = 'set_conclusion';
    next_params = { pr_number, conclusion: 'success', report_text: '...' };
  } else if (allPhasesSuccess && conclusionDone) {
    next_action = 'merge_pr';
    next_params = { pr_number };
    merge_ready = true;
  } else {
    // phases completed but not all success
    next_action = 'run_pr_checks';
  }

  return {
    ok: true,
    pr: { number: pr.number, title: pr.title, head_sha: pr.head_sha },
    prerequisites: { config_exists: !!config, git_clean: true, token_valid: true },
    phases,
    conclusion_status: conclusionCheckRun?.conclusion || 'not_set',
    merge_ready,
    next_action,
    next_params,
    blocker: null,
    blocker_resolution: null,
  };
}

// V2 marker patterns for backward compat (section 12.5)
const V2_REVIEW_PHASE_MARKER = /<!--\s*review-phase:\s*(\d+)\s*-->/;
const V2_REVIEW_COMMIT_MARKER = /<!--\s*review-commit:\s*([a-f0-9]+)\s*-->/;

function parseV2Comment(comment) {
  const phaseMatch = comment.body?.match(V2_REVIEW_PHASE_MARKER);
  const commitMatch = comment.body?.match(V2_REVIEW_COMMIT_MARKER);
  if (!phaseMatch || !commitMatch) return null;
  return {
    phase: parseInt(phaseMatch[1], 10),
    commit_sha: commitMatch[1],
    body: comment.body,
    created_at: comment.created_at,
  };
}

async function tryV2Compat(platform, prNumber, currentSha) {
  try {
    const comments = await platform.listPRComments(prNumber);
    const parsed = comments.map(parseV2Comment).filter(Boolean);

    // Look for phase 3 comment (final review in v2)
    const phase3 = parsed.filter((p) => p.phase === 3);
    if (phase3.length === 0) return null;

    const latest = phase3.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

    // Extract conclusion from v2 comment
    let v2Conclusion = 'neutral';
    if (latest.body.includes('<!-- pr-forge-conclusion: success -->')) {
      v2Conclusion = 'success';
    } else if (latest.body.includes('<!-- pr-forge-conclusion: failure -->')) {
      v2Conclusion = 'failure';
    }

    const shaMatch = latest.commit_sha === currentSha;

    return {
      source: 'v2_compat',
      sha_match: shaMatch,
      v2_conclusion: v2Conclusion,
      v2_phase: latest.phase,
      v2_commit: latest.commit_sha,
      expired: !shaMatch,
    };
  } catch {
    return null;
  }
}

async function get_review_status(params, platform) {
  const { pr_number } = params || {};

  let pr;
  try {
    pr = await platform.getPR(pr_number);
  } catch (e) {
    return error(e.code || 'PR_NOT_FOUND');
  }

  // Try Check Runs first
  let checkRuns;
  try {
    checkRuns = await platform.listCheckRuns(pr.head_sha);
  } catch {
    // listCheckRuns failed — fall through to v2 compat
    checkRuns = { check_runs: [] };
  }

  const all = checkRuns?.check_runs || [];
  const { phases: phaseCheckRuns, conclusion: conclusionCheckRun } = getPhaseCheckRuns({ check_runs: all });
  const currentSha = pr.head_sha;

  // If no Check Runs at all, try v2 backward compat
  if (all.length === 0) {
    const v2 = await tryV2Compat(platform, pr_number, currentSha);
    if (v2) {
      return {
        ok: true,
        pr: { number: pr.number, head_sha: pr.head_sha },
        phases: {},
        conclusion: {
          conclusion: v2.v2_conclusion,
          report_sha: v2.v2_commit,
          source: 'v2_compat',
        },
        aggregate: v2.sha_match ? v2.v2_conclusion : 'expired',
        merge_blocked: !v2.sha_match || v2.v2_conclusion !== 'success',
        merge_block_reason: v2.expired
          ? 'v2 审查结果已过期（SHA 不匹配），请重新 run_pr_checks'
          : v2.v2_conclusion !== 'success'
            ? 'v2 审查结论非 success'
            : null,
        source: 'v2_compat',
        v2_expired: v2.expired,
      };
    }
  }

  const phases = {};
  for (const cr of phaseCheckRuns) {
    const phaseId = cr.name.replace(PR_FORGE_CHECK_RUN_PREFIX, '');
    const shaVerified = cr.head_sha === currentSha;
    phases[phaseId] = {
      conclusion: cr.conclusion,
      sha_verified: shaVerified,
      completed_at: cr.completed_at || null,
      stale: !shaVerified,
    };
  }

  const conclusions = Object.values(phases).map((p) => p.conclusion).filter(Boolean);

  let aggregate = 'not_started';
  if (conclusions.length > 0) {
    if (conclusions.every((c) => c === 'success')) {
      aggregate = 'success';
    } else if (conclusions.some((c) => c === 'failure')) {
      aggregate = 'failure';
    } else {
      aggregate = 'neutral';
    }
  }

  const anyStale = Object.values(phases).some((p) => p.stale);

  let merge_blocked = true;
  let merge_block_reason = null;

  if (anyStale) {
    merge_block_reason = '部分验证结果 SHA 已过时，请重新 run_pr_checks';
  } else if (aggregate === 'failure') {
    merge_block_reason = '验证未通过，请修复后重新 run_pr_checks';
  } else if (aggregate === 'not_started') {
    merge_block_reason = '未执行 run_pr_checks，禁止合并';
  } else if (!conclusionCheckRun) {
    merge_block_reason = '审查未完成，请先调 set_conclusion';
  } else if (conclusionCheckRun.conclusion === 'failure') {
    merge_block_reason = '审查结论为 failure，禁止合并';
  } else {
    merge_blocked = false;
  }

  return {
    ok: true,
    pr: { number: pr.number, head_sha: pr.head_sha },
    phases,
    conclusion: conclusionCheckRun ? {
      conclusion: conclusionCheckRun.conclusion,
      report_sha: conclusionCheckRun.head_sha,
    } : null,
    aggregate,
    merge_blocked,
    merge_block_reason,
    source: 'check_runs',
  };
}

export { get_review_plan, get_review_status };
