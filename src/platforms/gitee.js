import { ErrorCode } from '../error-codes.js';

const GITEE_API = 'https://gitee.com/api/v5';

class GiteePlatform {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  async fetchApi(path, opts = {}) {
    const url = `${GITEE_API}${path}`;
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    };

    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 401 || res.status === 403) {
      const e = new Error(ErrorCode.AUTH_REQUIRED.message);
      e.code = ErrorCode.AUTH_REQUIRED.code;
      throw e;
    }
    if (res.status === 404) {
      const e = new Error(ErrorCode.PR_NOT_FOUND.message);
      e.code = ErrorCode.PR_NOT_FOUND.code;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`Gitee API error: ${res.status}`);
      e.code = ErrorCode.NETWORK_ERROR.code;
      throw e;
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return { data: await res.json() };
    }
    return { data: await res.text() };
  }

  async getPR(prNumber) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`);
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      draft: data.draft || false,
      head_sha: data.head.sha,
      head_ref: data.head.ref,
      base_ref: data.base.ref,
      author: data.user.login,
      html_url: data.html_url,
    };
  }

  async listPRs(state, head) {
    let qs = `state=${state || 'open'}`;
    if (head) qs += `&head=${encodeURIComponent(head)}`;
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls?${qs}`);
    return data.map((d) => ({
      number: d.number,
      title: d.title,
      state: d.state,
      draft: d.draft || false,
      head_sha: d.head.sha,
      head_ref: d.head.ref,
      base_ref: d.base.ref,
      author: d.user.login,
      html_url: d.html_url,
    }));
  }

  async getDiff(prNumber) {
    // Gitee doesn't have a diff API that returns raw text like GitHub,
    // but it does have a similar endpoint.
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}.diff`);
    return typeof data === 'string' ? data : JSON.stringify(data);
  }

  async getFileContent(filePath, ref) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref || 'master')}`);
    if (data.content && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return data.content || '';
  }

  async createCommitStatus(sha, state, targetUrl, context, description) {
    const body = { state, target_url: targetUrl || '', context, description };
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/commits/${sha}/statuses`, { method: 'POST', body });
    return data;
  }

  async listCommitStatuses(sha) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/commits/${sha}/statuses`);
    return data;
  }

  async listPRComments(prNumber) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/comments`);
    return data;
  }

  async createPRComment(prNumber, body) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/comments`, { method: 'POST', body: { body } });
    return data;
  }

  async mergePR(prNumber, mergeMethod = 'merge') {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: { merge_method: mergeMethod },
    });
    return data;
  }

  async createCheckRun(headSha, name, opts = {}) {
    const state = opts.conclusion || 'success';
    const description = (opts.output?.summary || '').slice(0, 140);
    const targetUrl = '';
    return this.createCommitStatus(headSha, state, targetUrl, name, description);
  }

  async updateCheckRun(checkRunId, opts = {}) {
    return { id: checkRunId, ...opts };
  }

  async listCheckRuns(ref) {
    const statuses = await this.listCommitStatuses(ref);
    const runs = statuses
      .filter((s) => s.context && s.context.startsWith('pr-forge/'))
      .map((s) => ({
        id: s.id,
        name: s.context,
        conclusion: s.state,
        head_sha: ref,
        status: 'completed',
        completed_at: s.updated_at || null,
        output: { title: s.context, summary: s.description || '' },
      }));
    return { check_runs: runs };
  }

  async getUser() {
    const { data } = await this.fetchApi('/user');
    return data;
  }
}

export { GiteePlatform };
