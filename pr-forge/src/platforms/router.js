import { GitHubPlatform } from './github.js';
import { GiteePlatform } from './gitee.js';

function detectPlatform({ remote }) {
  if (!remote) return null;
  let m;

  m = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  if (m) return { platform: 'github', owner: m[1], repo: m[2] };

  m = remote.match(/gitee\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  if (m) return { platform: 'gitee', owner: m[1], repo: m[2] };

  return null;
}

function createPlatform(platform, token, owner, repo) {
  switch (platform) {
    case 'github': return new GitHubPlatform(token, owner, repo);
    case 'gitee': return new GiteePlatform(token, owner, repo);
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

export { detectPlatform, createPlatform };
