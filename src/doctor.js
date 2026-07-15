import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const CHECKS = [
  { key: 'nodeVersion', label: 'Node.js 版本 ≥ 20' },
  { key: 'configValid', label: '.pr-forge/config.json 存在且 hash 校验通过' },
  { key: 'credentials', label: '~/.pr-forge/credentials 可读' },
  { key: 'gitEnv', label: 'git 环境正常' },
  { key: 'tokenValid', label: '平台 API token 有效' },
  { key: 'npmRegistry', label: 'npm 注册状态' },
];

async function runDoctor(projectRoot, platform) {
  const results = {};

  // Node.js version
  const nodeVersion = parseInt(process.version.replace('v', '').split('.')[0], 10);
  results.nodeVersion = { pass: nodeVersion >= 20, detail: process.version };

  // Config
  const configPath = path.join(projectRoot, '.pr-forge', 'config.json');
  const approvedPath = path.join(projectRoot, '.pr-forge', '.approved');
  const configExists = fs.existsSync(configPath) && fs.existsSync(approvedPath);
  results.configValid = { pass: configExists, detail: configExists ? 'OK' : '配置不存在或 .approved 缺失' };

  // Credentials
  const credPath = path.join(homedir(), '.pr-forge', 'credentials');
  const credExists = fs.existsSync(credPath);
  results.credentials = { pass: credExists, detail: credExists ? 'OK' : '未找到 credentials 文件' };

  // Git
  try {
    execSync('git --version', { stdio: 'pipe' });
    execSync('git rev-parse --show-toplevel', { cwd: projectRoot, stdio: 'pipe' });
    results.gitEnv = { pass: true, detail: 'OK' };
  } catch {
    results.gitEnv = { pass: false, detail: 'git 环境异常' };
  }

  // Token
  if (platform) {
    try {
      await platform.getUser();
      results.tokenValid = { pass: true, detail: 'OK' };
    } catch {
      results.tokenValid = { pass: false, detail: 'Token 无效或 API 不可达' };
    }
  } else {
    results.tokenValid = { pass: false, detail: '未配置 platform' };
  }

  // npm registry
  try {
    execSync('npm view pr-forge version', { stdio: 'pipe', timeout: 5000 });
    results.npmRegistry = { pass: true, detail: 'pr-forge 已发布' };
  } catch {
    results.npmRegistry = { pass: false, detail: 'pr-forge 未发布到 npm（不影响本地开发使用）' };
  }

  const checks = CHECKS.map((c) => ({
    name: c.label,
    pass: results[c.key]?.pass || false,
    detail: results[c.key]?.detail || 'N/A',
  }));

  return {
    allPass: checks.every((c) => c.pass),
    checks,
  };
}

export { runDoctor, CHECKS };
