import { error } from '../error-codes.js';

async function get_pr_context(params, platform) {
  const { pr_number } = params;

  if (!pr_number || pr_number < 1) {
    return error('PR_NOT_FOUND');
  }

  try {
    const pr = await platform.getPR(pr_number);
    return {
      ok: true,
      pr: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        head_sha: pr.head_sha,
        head_ref: pr.head_ref,
        base_ref: pr.base_ref,
        author: pr.author,
      },
    };
  } catch (e) {
    if (e.code) return error(e.code);
    return error('PR_NOT_FOUND');
  }
}

export { get_pr_context };
