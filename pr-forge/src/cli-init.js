import * as readline from 'node:readline';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import {
  detectAllProjectTypes, mergePhases, generateConfig,
  saveCredentials, readCredentials,
  generateMcpJson, generateCodexMcpJson, checkV2Install,
} from './init.js';
import { createAppJWT, validateApp } from './platforms/github.js';

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 120_000;

function getGitRemote() {
  try {
    return execSync('git config --get remote.origin.url', {
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
  } catch { return null; }
}

function parseGitHost(remote) {
  if (remote?.match(/github\.com/)) return 'github';
  if (remote?.match(/gitee\.com/)) return 'gitee';
  return null;
}

function parseGitHubRemote(remote) {
  const match = remote?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

// ============ GitHub App Manifest Flow (from cli-auth.js) ============

function buildManifest(owner, redirectUrl) {
  const name = `pr-forge${owner ? `-${owner}` : ''}`;
  return {
    name, url: 'https://github.com/wang654993222/pr-forge',
    description: 'AI Code Review Gateway — Agent must pass PR review before merge',
    public: false, redirect_url: redirectUrl,
    default_permissions: { checks: 'write', pull_requests: 'write', contents: 'write', metadata: 'read' },
    default_events: [],
  };
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildLandingPage(manifestJson, state) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>pr-forge — 创建 GitHub App</title></head>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>pr-forge GitHub App 授权</h1>
<p>以下 App 配置已自动预填。确认无误后，点击下方按钮跳转到 GitHub 完成创建。</p>
<h2>App 配置预览</h2>
<pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:16px;overflow-x:auto;font-size:13px;line-height:1.5">${escapeHtml(JSON.stringify(JSON.parse(manifestJson), null, 2))}</pre>
<p style="margin-top:24px"><strong>跳转到 GitHub 后，你只需要点击页面底部的 <span style="color:#2da44e">Create GitHub App</span> 按钮即可。</strong></p>
<form id="f" method="POST" action="https://github.com/settings/apps/new" style="margin-top:24px">
<input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}" />
<input type="hidden" name="state" value="${state}" />
<button type="submit" style="background:#2da44e;color:#fff;border:none;padding:12px 24px;font-size:16px;border-radius:6px;cursor:pointer">前往 GitHub 创建 App →</button>
</form></body></html>`;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, 'localhost', () => { const p = server.address().port; server.close(() => resolve(p)); });
    server.on('error', reject);
  });
}

async function exchangeManifestCode(code) {
  const res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes('Marketplace')) {
      throw new Error('请先接受 GitHub Marketplace Developer Agreement。打开 https://github.com/settings/apps 点击 Accept，然后重新运行 pr-forge init。');
    }
    if (res.status === 404) throw new Error('Manifest code 无效或已过期。请重新运行 pr-forge init。');
    throw new Error(`Manifest exchange failed: HTTP ${res.status}`);
  }
  return res.json();
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd = platform === 'darwin' ? `open "${url}"` : platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

async function runManifestFlow(projectRoot, parsed) {
  // Check existing App credentials
  const existing = readCredentials();
  if (existing?.appId && existing?.privateKey) {
    console.log('→ 检测到已有 GitHub App 凭据，正在验证...');
    const jwt = createAppJWT(existing.appId, existing.privateKey);
    if (jwt && await validateApp(jwt)) {
      console.log(`✓ App #${existing.appId} 有效，直接复用\n`);
      return true;
    }
    console.log('⚠️  已有凭证无效（App 可能已被删除），将重新授权。\n');
  }

  let port;
  try { port = await findFreePort(); } catch { console.error('✗ 无法启动本地回调服务器。'); process.exit(1); }

  const state = randomBytes(16).toString('hex');
  const callbackUrl = `http://localhost:${port}/callback`;
  const manifest = buildManifest(parsed?.owner, callbackUrl);
  const manifestJson = JSON.stringify(manifest);
  const landingHtml = buildLandingPage(manifestJson, state);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  App 名称: ${manifest.name}`);
  console.log('  权限: checks:write, pull_requests:write, contents:read');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const result = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      if (reqUrl.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(landingHtml); return; }
      if (reqUrl.pathname === '/callback') {
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        if (returnedState !== state) { res.writeHead(400); res.end('State mismatch'); server.close(); reject(new Error('State mismatch')); return; }
        if (!code) { res.writeHead(400); res.end('No code'); server.close(); reject(new Error('No code')); return; }
        try {
          console.log('→ 正在交换授权码...');
          const appConfig = await exchangeManifestCode(code);
          resolve({ appConfig, res, server });
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body><h1>交换失败</h1><p>${err.message}</p></body></html>`);
          server.close(); reject(err);
        }
        return;
      }
      res.writeHead(404); res.end();
    });

    const landingUrl = `http://localhost:${port}/`;
    server.listen(port, '127.0.0.1', () => {
      console.log('→ 正在打开浏览器...');
      console.log('→ 等待用户授权...\n');
      const opened = openBrowser(landingUrl);
      if (!opened) console.log(`⚠️  无法自动打开浏览器，请手动复制: ${landingUrl}\n`);
    });
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('授权超时（2 分钟），请重试。')); }, TIMEOUT_MS);
  });

  const { appConfig, res, server } = result;
  saveCredentials({ appId: appConfig.id, privateKey: appConfig.pem });
  console.log(`\n✓ App ID: ${appConfig.id}`);
  console.log('✓ 凭据已保存到 ~/.pr-forge/credentials');

  const installUrl = `https://github.com/settings/apps/${appConfig.slug || 'pr-forge'}/installations`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><head><meta charset="utf-8"><title>授权成功</title></head>
<body style="font-family:system-ui;max-width:480px;margin:40px auto;text-align:center">
<h1 style="color:#2da44e">授权成功</h1>
<p><strong>pr-forge</strong> GitHub App 已创建并保存。</p>
<p style="color:#656d76">App ID: ${appConfig.id}</p>
<p style="margin-top:24px">正在跳转到安装页面...</p>
<p style="color:#656d76;font-size:13px">如未自动跳转，<a href="${installUrl}">点击这里</a></p>
<script>setTimeout(function(){ location.href = "${installUrl}"; }, 1500);</script></body></html>`);
  server.close();

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✓ GitHub App 授权完成！');
  console.log(`  安装地址: ${installUrl}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  return true;
}

// ============ Main init command ============

async function prompt(rl, question) {
  return new Promise((resolve) => { rl.question(question, resolve); });
}

async function initCommand(args) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const projectRoot = process.cwd();
  console.log('\npr-forge v3.1 初始化\n');

  if (checkV2Install(projectRoot)) {
    console.log('⚠️  检测到 pr-forge v2 安装。v2 Python 版已 EOL，init 将覆盖 mcp.json 配置。\n');
  }

  // Detect git remote and platform
  const remote = getGitRemote();
  const platform = parseGitHost(remote);
  const githubParsed = platform === 'github' ? parseGitHubRemote(remote) : null;

  if (platform === 'github') {
    console.log(`✓ 检测到 GitHub 仓库: ${githubParsed.owner}/${githubParsed.repo}`);
    console.log('→ 将使用 GitHub App 认证（Check Runs 支持）\n');
    await runManifestFlow(projectRoot, githubParsed);
  } else if (platform === 'gitee') {
    console.log('✓ 检测到 Gitee 仓库');
    const existingCreds = readCredentials();
    let token;
    if (existingCreds?.token) {
      console.log('✓ 检测到已有 token，直接复用\n');
      token = existingCreds.token;
    } else {
      const tokenArg = args.find((a) => a.startsWith('--token='));
      if (tokenArg) {
        token = tokenArg.split('=')[1];
      } else {
        token = await prompt(rl, '请输入 Gitee Token: ');
      }
      if (token) { saveCredentials(token); console.log('✓ Token 已备份到 ~/.pr-forge/credentials\n'); }
    }
  } else {
    console.log('⚠️  未检测到 GitHub 或 Gitee 仓库');
    console.log('   请在仓库根目录运行 pr-forge init\n');
    rl.close();
    process.exit(1);
  }

  // Detect ALL project types
  const detectedTypes = detectAllProjectTypes(projectRoot);
  if (detectedTypes.length > 0) {
    console.log(`✓ 检测到 ${detectedTypes.length} 种项目类型:`);
    detectedTypes.forEach((dt) => console.log(`    - ${dt.type}`));

    // Ask if user wants to add more
    let answer = 'n';
    try {
      answer = await prompt(rl, '\n→ 是否增加其他项目类型？[y/N] ');
    } catch { answer = 'n'; }
    const allTypes = detectAllProjectTypes(projectRoot); // re-detect in case they want to add
    if (answer.toLowerCase() === 'y') {
      const allDetectors = (await import('./init.js')).PROJECT_DETECTORS;
      const alreadyDetected = new Set(allTypes.map((dt) => dt.type));
      const available = allDetectors.filter((d) => !alreadyDetected.has(d.type));

      if (available.length > 0) {
        console.log('\n  可选项目类型：');
        available.forEach((d, i) => console.log(`    [${i + 1}] ${d.type}  → ${d.defaultPhases[0]?.check || '自定义'}`));
        console.log(`    [0] 自定义`);
        const choice = await prompt(rl, '\n  输入编号（逗号分隔，回车跳过）: ');
        if (choice.trim()) {
          const indices = choice.split(',').map((s) => parseInt(s.trim()));
          for (const idx of indices) {
            if (idx === 0) {
              let customName = ''; try { customName = await prompt(rl, '  自定义名称: '); } catch { customName = ''; }
              let customCmd = ''; try { customCmd = await prompt(rl, '  验证命令: '); } catch { customCmd = ''; }
              allTypes.push({ type: customName, defaultPhases: [{ id: `custom-${allTypes.length}`, name: customName, check: customCmd }] });
            } else if (available[idx - 1]) {
              allTypes.push(available[idx - 1]);
            }
          }
        }
      }
    }

    const phases = mergePhases(allTypes);
    console.log('\n  验证阶段:');
    phases.forEach((p) => console.log(`    - ${p.id}: ${p.check}`));
    generateConfig(projectRoot, phases);
    console.log('✓ .pr-forge/config.json 已生成（含 .approved hash）');
  } else {
    console.log('⚠️  未检测到已知项目类型');
    generateConfig(projectRoot, []);
    console.log('✓ .pr-forge/config.json 已生成（空模板，请手动编辑）');
  }

  // Generate MCP configs
  generateMcpJson(projectRoot, 'pr-forge');
  console.log('✓ .claude/mcp.json 已生成');
  generateCodexMcpJson('pr-forge');
  console.log('✓ Codex 插件已安装到 marketplace');
  console.log('\n⚠️  mcp.json 已加入 .gitignore，不要手动取消。');

  console.log('\n✓ 初始化完成！现在可以告诉你的 Agent: "审查 PR #N"\n');
  rl.close();
}

export { initCommand };
