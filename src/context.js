import { execSync } from 'node:child_process';
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

function getToken(env) {
  return env.PR_FORGE_TOKEN || env.GITHUB_TOKEN || env.GITEE_TOKEN || null;
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

function resolvePlatform(env) {
  const info = getPlatformInfo(env);
  if (!info) return null;
  return createPlatform(info.platform, info.token, info.owner, info.repo);
}

export {
  getProjectRoot,
  getGitRemote,
  getCurrentBranch,
  getToken,
  getPlatformInfo,
  resolvePlatform,
};
