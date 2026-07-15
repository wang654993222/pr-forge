import { ErrorCode } from '../error-codes.js';

const GITHUB_API = 'https://api.github.com';

class GitHubPlatform {
  constructor(token, owner, repo) {
    this.token = token;
    this.owner = owner;
    this.repo = repo;
  }

  async fetchApi(path, opts = {}) {
    const url = `${GITHUB_API}${path}`;
    const acceptHeader = opts.headers?.accept || 'application/vnd.github+json';
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: acceptHeader,
      'X-GitHub-Api-Version': '2022-11-28',
      ...opts.headers,
    };

    if (opts.body) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 401) {
      const e = new Error(ErrorCode.AUTH_REQUIRED.message);
      e.code = ErrorCode.AUTH_REQUIRED.code;
      throw e;
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      const e = new Error(ErrorCode.RATE_LIMITED.message);
      e.code = ErrorCode.RATE_LIMITED.code;
      e.retryAfter = res.headers.get('x-ratelimit-reset');
      throw e;
    }
    if (res.status === 404) {
      const e = new Error(ErrorCode.PR_NOT_FOUND.message);
      e.code = ErrorCode.PR_NOT_FOUND.code;
      throw e;
    }
    if (!res.ok) {
      const e = new Error(`GitHub API error: ${res.status}`);
      e.code = ErrorCode.NETWORK_ERROR.code;
      throw e;
    }

    if (opts.headers?.accept === 'application/vnd.github.v3.diff') {
      return { data: await res.text() };
    }

    return { data: await res.json() };
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
    const headers = { accept: 'application/vnd.github.v3.diff' };
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`, { headers });
    return data;
  }

  async getFileContent(filePath, ref) {
    const qs = `ref=${encodeURIComponent(ref || 'main')}`;
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/contents/${encodeURIComponent(filePath)}?${qs}`);
    if (data.content && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return data.content || '';
  }

  async createCheckRun(headSha, name, { conclusion, output, status } = {}) {
    const body = { name, head_sha: headSha, status: status || 'completed' };
    if (conclusion) body.conclusion = conclusion;
    if (output) body.output = output;
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/check-runs`, { method: 'POST', body });
    return data;
  }

  async updateCheckRun(checkRunId, { conclusion, output, status } = {}) {
    const body = {};
    if (conclusion) body.conclusion = conclusion;
    if (output) body.output = output;
    if (status) body.status = status;
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/check-runs/${checkRunId}`, { method: 'PATCH', body });
    return data;
  }

  async listCheckRuns(ref) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/commits/${ref}/check-runs`);
    return data;
  }

  async mergePR(prNumber, mergeMethod = 'merge') {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: { merge_method: mergeMethod },
    });
    return data;
  }

  async getUser() {
    const { data } = await this.fetchApi('/user');
    return data;
  }

  async listPRComments(prNumber) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`);
    return data;
  }
}

export { GitHubPlatform };
