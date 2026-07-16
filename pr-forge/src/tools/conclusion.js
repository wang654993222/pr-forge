import { ErrorCode, error } from '../error-codes.js';

const MAX_OUTPUT_LENGTH = 65535;

const VALID_CONCLUSIONS = ['success', 'failure', 'neutral'];

function truncateText(text) {
  if (!text || text.length <= MAX_OUTPUT_LENGTH) return text;
  return text.slice(0, MAX_OUTPUT_LENGTH) + '\n\n> 报告过长已截断';
}

function getPhaseCheckRuns(checkRuns) {
  const all = checkRuns?.check_runs || [];
  return all.filter((cr) => cr.name !== 'pr-forge/conclusion');
}

async function set_conclusion(params, platform) {
  const { pr_number, conclusion, report_text } = params;

  if (!VALID_CONCLUSIONS.includes(conclusion)) {
    return error('INVALID_VERDICT');
  }

  try {
    const pr = await platform.getPR(pr_number);
    const checkRuns = await platform.listCheckRuns(pr.head_sha);
    const all = checkRuns?.check_runs || [];
    const existingConclusion = all.find((cr) => cr.name === 'pr-forge/conclusion');

    if (existingConclusion && existingConclusion.head_sha !== pr.head_sha) {
      return error('REVIEW_STALE');
    }

    const outputText = report_text || '';
    const truncatedText = truncateText(outputText);

    let result;
    if (existingConclusion) {
      result = await platform.updateCheckRun(existingConclusion.id, {
        conclusion,
        output: { title: 'PR Flow 审查结论', summary: `审查结论: ${conclusion}`, text: truncatedText },
      });
    } else {
      result = await platform.createCheckRun(pr.head_sha, 'pr-forge/conclusion', {
        conclusion,
        output: { title: 'PR Flow 审查结论', summary: `审查结论: ${conclusion}`, text: truncatedText },
      });
    }

    return {
      ok: true,
      conclusion,
      check_run_name: result.name,
    };
  } catch (e) {
    if (e.code) return error(e.code);
    return error('NETWORK_ERROR');
  }
}

async function merge_pr(params, platform) {
  const { pr_number, merge_method, acknowledge } = params;

  try {
    const pr = await platform.getPR(pr_number);
    const checkRuns = await platform.listCheckRuns(pr.head_sha);
    const all = checkRuns?.check_runs || [];

    // Step 0: v2 compat path — if no Check Runs, check v2 review data
    if (all.length === 0) {
      // Import dynamically to avoid circular dependency — or inline the check
      const { get_review_status } = await import('./review.js');
      const v2Status = await get_review_status({ pr_number }, platform);

      if (v2Status.ok && v2Status.source === 'v2_compat' && !v2Status.v2_expired) {
        const v2Conclusion = v2Status.conclusion?.conclusion;
        if (v2Conclusion === 'success') {
          const result = await platform.mergePR(pr_number, merge_method || 'merge');
          return { ok: true, merged: result.merged, message: result.message };
        }
        if (v2Conclusion === 'neutral') {
          if (acknowledge !== true) {
            return {
              ok: false,
              error: {
                code: ErrorCode.MERGE_NOT_ALLOWED.code,
                message: '请 acknowledge=true 确认审查意见中的风险',
                recovery: '确认已了解审查报告中的风险后，传入 acknowledge=true 参数重试合并',
              },
            };
          }
          const result = await platform.mergePR(pr_number, merge_method || 'merge');
          return { ok: true, merged: result.merged, message: result.message };
        }
        return {
          ok: false,
          error: {
            code: ErrorCode.MERGE_NOT_ALLOWED.code,
            message: `v2 审查结论为 ${v2Conclusion}，禁止合并`,
            recovery: 'v2 审查未通过，修复后重新审查',
          },
        };
      }

      // v2 compat failed — return error
      if (v2Status.ok && v2Status.v2_expired) {
        return error('REVIEW_STALE');
      }

      return {
        ok: false,
        error: {
          code: ErrorCode.MERGE_NOT_ALLOWED.code,
          message: '未执行 run_pr_checks，禁止合并',
          recovery: ErrorCode.MERGE_NOT_ALLOWED.recovery,
        },
      };
    }

    // Step 1: SHA stale check — auto re-validate instead of rejecting
    const phaseCheckRuns = all.filter(
      (cr) => cr.name.startsWith('pr-forge/') && cr.name !== 'pr-forge/conclusion'
    );
    const conclusionCheckRun = all.find((cr) => cr.name === 'pr-forge/conclusion');

    const phaseStale = phaseCheckRuns.some((cr) => cr.head_sha !== pr.head_sha);
    const conclusionStale = conclusionCheckRun && conclusionCheckRun.head_sha !== pr.head_sha;

    if (phaseStale || conclusionStale) {
      // Auto re-run run_pr_checks on the new commit
      const { run_pr_checks } = await import('./checks.js');
      const recheckResult = await run_pr_checks({ pr_number }, null, platform, null, null);
      if (!recheckResult.ok) return recheckResult;

      // Re-fetch check runs after re-validate
      const newCheckRuns = await platform.listCheckRuns(pr.head_sha);
      const newAll = newCheckRuns?.check_runs || [];
      const newPhases = newAll.filter((cr) => cr.name.startsWith('pr-forge/') && cr.name !== 'pr-forge/conclusion');
      const newConclusion = newAll.find((cr) => cr.name === 'pr-forge/conclusion') || conclusionCheckRun;

      if (newPhases.length === 0) {
        return { ok: false, error: { code: ErrorCode.MERGE_NOT_ALLOWED.code, message: '自动重验证失败，请手动调 run_pr_checks', recovery: ErrorCode.MERGE_NOT_ALLOWED.recovery }};
      }

      const newConclusions = newPhases.map((c) => c.conclusion);
      if (newConclusions.some((c) => c === 'failure')) {
        return { ok: false, error: { code: ErrorCode.MERGE_NOT_ALLOWED.code, message: '验证未通过（自动重验证），先修复', recovery: ErrorCode.MERGE_NOT_ALLOWED.recovery }};
      }

      if (newConclusion?.conclusion === 'neutral') {
        if (acknowledge !== true) {
          return { ok: false, error: { code: ErrorCode.MERGE_NOT_ALLOWED.code, message: '请 acknowledge=true 确认审查意见中的风险', recovery: '确认已了解审查报告中的风险后，传入 acknowledge=true 参数重试合并' }};
        }
      }

      if (newConclusion?.conclusion === 'failure') {
        return { ok: false, error: { code: ErrorCode.MERGE_NOT_ALLOWED.code, message: '审查结论为 failure，禁止合并', recovery: '修复审查报告中指出的问题后重新 set_conclusion' }};
      }

      const result = await platform.mergePR(pr_number, merge_method || 'merge');
      return { ok: true, merged: result.merged, message: result.message, revalidated: true };
    }

    // Step 2-3: Aggregate phase results
    if (phaseCheckRuns.length === 0) {
      return {
        ok: false,
        error: {
          code: ErrorCode.MERGE_NOT_ALLOWED.code,
          message: '未执行 run_pr_checks，禁止合并',
          recovery: ErrorCode.MERGE_NOT_ALLOWED.recovery,
        },
      };
    }

    const conclusions = phaseCheckRuns.map((c) => c.conclusion);
    const hasFailure = conclusions.some((c) => c === 'failure');

    if (hasFailure) {
      return {
        ok: false,
        error: {
          code: ErrorCode.MERGE_NOT_ALLOWED.code,
          message: '验证未通过，先修复',
          recovery: ErrorCode.MERGE_NOT_ALLOWED.recovery,
        },
      };
    }

    // Step 5: Check conclusion exists
    if (!conclusionCheckRun) {
      return {
        ok: false,
        error: {
          code: ErrorCode.MERGE_NOT_ALLOWED.code,
          message: '审查未完成，请调 set_conclusion',
          recovery: ErrorCode.MERGE_NOT_ALLOWED.recovery,
        },
      };
    }

    // Step 6-7: Check conclusion value
    if (conclusionCheckRun.conclusion === 'success') {
      // merge
      const result = await platform.mergePR(pr_number, merge_method || 'merge');
      return { ok: true, merged: result.merged, message: result.message };
    }

    if (conclusionCheckRun.conclusion === 'neutral') {
      if (acknowledge !== true) {
        return {
          ok: false,
          error: {
            code: ErrorCode.MERGE_NOT_ALLOWED.code,
            message: '请 acknowledge=true 确认审查意见中的风险',
            recovery: '确认已了解审查报告中的风险后，传入 acknowledge=true 参数重试合并',
          },
        };
      }
      const result = await platform.mergePR(pr_number, merge_method || 'merge');
      return { ok: true, merged: result.merged, message: result.message };
    }

    if (conclusionCheckRun.conclusion === 'failure') {
      return {
        ok: false,
        error: {
          code: ErrorCode.MERGE_NOT_ALLOWED.code,
          message: '审查结论为 failure，禁止合并',
          recovery: '修复审查报告中指出的问题后重新 set_conclusion，或与审查者讨论结论',
        },
      };
    }

    return error('MERGE_NOT_ALLOWED');
  } catch (e) {
    if (e.code) return error(e.code);
    return error('NETWORK_ERROR');
  }
}

export { set_conclusion, merge_pr };
