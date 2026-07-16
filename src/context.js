import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { detectPlatform, createPlatform } from './platforms/router.js';

function getProjectRoot() {
  try {
    const root = execSync('git rev-parse --show-toplevel', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim();
    return root;
  } catch {
    return process.cwd();
  }
}

function getGitRemote() {
  try {
    const remote = execSync('git config --get remote.origin.url', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim();
    return remote;
  } catch {
    return null;
  }
}

function getCurrentBranch() {
  try {
    const branch = execSync('git branch --show-current', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString().trim();
    return branch;
  } catch {
    return null;
  }
}

function readCredsFile() {
  const credPath = path.join(homedir(), '.pr-forge', 'credentials');
  if (!fs.existsSync(credPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  } catch {
    return null;
  }
}

function getToken(env) {
  // 1) GitHub App: env vars (from mcp.json)
  const appId = env.PR_FORGE_GITHUB_APP_ID || null;
  const privateKey = env.PR_FORGE_GITHUB_APP_PRIVATE_KEY || null;
  const installationId = env.PR_FORGE_GITHUB_APP_INSTALLATION_ID || null;
  if (appId && privateKey) {
    return {
      __app: { appId: Number(appId), privateKey, installationId: installationId ? Number(installationId) : null },
    };
  }

  // 2) env var PAT
  const fromEnv = env.PR_FORGE_TOKEN || env.GITHUB_TOKEN || env.GITEE_TOKEN || null;
  if (fromEnv) return fromEnv;

  // 3) credentials file — GitHub App
  const creds = readCredsFile();
  if (creds?.appId && creds?.privateKey) {
    return {
      __app: { appId: creds.appId, privateKey: creds.privateKey, installationId: creds.installationId || null },
    };
  }

  // 4) credentials file — PAT
  if (creds?.token) return creds.token;

  return null;
}

function isAppToken(token) {
  return token && typeof token === 'object' && token.__app;
}

function getPlatformInfo(env) {
  const remote = getGitRemote();
  const detected = detectPlatform({ remote });
  if (!detected) return null;
  return {
    ...detected,
    token: getToken(env),
  };
}

async function resolvePlatform(env) {
  const info = getPlatformInfo(env);
  if (!info) return null;

  let token = info.token;

  // If credentials are for a GitHub App, generate an installation token (ghs_)
  if (isAppToken(token)) {
    const { createAppJWT, getInstallationToken } = await import('./platforms/github.js');
    const jwt = createAppJWT(token.__app.appId, token.__app.privateKey);
    token = await getInstallationToken(jwt, token.__app.installationId, info.owner, info.repo);
    if (!token) return null;
  }

  return createPlatform(info.platform, token, info.owner, info.repo);
}

export {
  getProjectRoot,
  getGitRemote,
  getCurrentBranch,
  getToken,
  getPlatformInfo,
  resolvePlatform,
};
