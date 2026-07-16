import { createPrivateKey, sign } from 'node:crypto';
import { ErrorCode } from '../error-codes.js';

const GITHUB_API = 'https://api.github.com';

// JWT signing with raw RSA (zero npm deps, Node 20+ built-in)
function createAppJWT(appId, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: String(appId),
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const keyObj = createPrivateKey(privateKeyPem);
    const signatureBytes = sign('RSA-SHA256', Buffer.from(signingInput), keyObj);
    const encodedSignature = signatureBytes.toString('base64url');
    return `${signingInput}.${encodedSignature}`;
  } catch {
    return null;
  }
}

// Exchange JWT for an installation access token
async function getInstallationToken(jwt, knownInstallationId, owner, repo) {
  let instId = knownInstallationId;

  // Auto-discover installation ID if not known
  if (!instId) {
    try {
      const appRes = await fetch(`${GITHUB_API}/app/installations`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!appRes.ok) throw new Error(`HTTP ${appRes.status}`);
      const installations = await appRes.json();
      // Find the installation for this repo
      for (const inst of installations) {
        if (inst.account && inst.account.login === owner) {
          instId = inst.id;
          break;
        }
      }
    } catch {
      return null;
    }
  }

  if (!instId) return null;

  try {
    const tokenRes = await fetch(`${GITHUB_API}/app/installations/${instId}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status}`);
    const data = await tokenRes.json();
    return data.token;
  } catch {
    return null;
  }
}

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


  async createPR(title, head, base, body) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls`, {
      method: 'POST',
      body: { title, head, base, body: body || '' },
    });
    return {
      number: data.number,
      title: data.title,
      state: data.state,
      html_url: data.html_url,
    };
  }

  async getPRBody(prNumber) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`);
    return data.body || '';
  }

  async listPRComments(prNumber) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`);
    return data;
  }

  async listReviews(prNumber) {
    const { data } = await this.fetchApi(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/reviews`);
    return data;
  }
}

async function validateApp(jwt) {
  try {
    const res = await fetch(`${GITHUB_API}/app`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export { GitHubPlatform, createAppJWT, getInstallationToken, validateApp };
