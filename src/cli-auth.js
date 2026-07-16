#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import {
  saveCredentials,
  readCredentials,
  generateMcpJson,
} from './init.js';

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 120_000;

function getGitRemote() {
  try {
    return execSync('git config --get remote.origin.url', {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function parseGitRemote(remote) {
  const match = remote?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

function buildManifest(owner, redirectUrl) {
  const name = `pr-forge${owner ? `-${owner}` : ''}`;
  return {
    name,
    url: 'https://github.com/wang654993222/pr-forge',
    description:
      'AI Code Review Gateway — Agent must pass PR review before merge',
    public: false,
    redirect_url: redirectUrl,
    default_permissions: {
      checks: 'write',
      pull_requests: 'write',
      contents: 'write',
      metadata: 'read',
    },
    default_events: [],
  };
}

function buildLandingPage(manifestJson, state) {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><title>pr-forge — 创建 GitHub App</title></head>
<body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 20px">
  <h1>pr-forge GitHub App 授权</h1>
  <p>以下 App 配置已自动预填。确认无误后，点击下方按钮跳转到 GitHub 完成创建。</p>

  <h2>App 配置预览</h2>
  <pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:16px;overflow-x:auto;font-size:13px;line-height:1.5">${escapeHtml(JSON.stringify(JSON.parse(manifestJson), null, 2))}</pre>

  <p style="margin-top:24px"><strong>跳转到 GitHub 后，你只需要点击页面底部的 <span style="color:#2da44e">Create GitHub App</span> 按钮即可。无需修改任何字段。</strong></p>

  <form id="f" method="POST" action="https://github.com/settings/apps/new" style="margin-top:24px">
    <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}" />
    <input type="hidden" name="state" value="${state}" />
    <button type="submit" style="background:#2da44e;color:#fff;border:none;padding:12px 24px;font-size:16px;border-radius:6px;cursor:pointer">
      前往 GitHub 创建 App →
    </button>
  </form>

  <p style="color:#656d76;margin-top:24px;font-size:13px">点击按钮后将跳转到 GitHub，在那里完成最后一步确认。</p>
</body>
</html>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateState() {
  return randomBytes(16).toString('hex');
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, 'localhost', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function exchangeManifestCode(code) {
  const res = await fetch(
    `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  if (!res.ok) {
    const body = await res.text();

    // Detect common failure reasons
    if (body.includes('Marketplace')) {
      throw new Error(
        '你需要先接受 GitHub Marketplace Developer Agreement。\n' +
          '  打开 https://github.com/settings/apps ，根据页面提示点击"Accept"按钮，然后重新运行 pr-forge auth。',
      );
    }
    if (res.status === 404) {
      throw new Error(
        'Manifest code 无效或已过期。请重新运行 pr-forge auth。',
      );
    }

    throw new Error(`Manifest exchange failed: HTTP ${res.status} — ${body}`);
  }
  return res.json();
}

function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function authCommand(_args) {
  const projectRoot = process.cwd();

  console.log('\npr-forge GitHub App 授权 (Manifest Flow)\n');

  // Warn if existing credentials
  const existing = readCredentials();
  if (existing?.appId && existing?.privateKey) {
    console.log(
      '⚠️  已有 GitHub App 凭据 (~/.pr-forge/credentials)，继续操作将覆盖。',
    );
  } else if (existing?.token) {
    console.log(
      '⚠️  检测到 PAT token，App 授权后将替换为 GitHub App 凭据。',
    );
  }

  // Detect repo
  const remote = getGitRemote();
  const parsed = remote ? parseGitRemote(remote) : null;
  if (parsed) {
    console.log(`✓ 检测到仓库: ${parsed.owner}/${parsed.repo}`);
  } else {
    console.log('⚠️  未检测到 GitHub 仓库，将使用默认配置。');
  }
  console.log('');

  // Find free port
  let port;
  try {
    port = await findFreePort();
  } catch {
    console.error('✗ 无法启动本地回调服务器。');
    process.exit(1);
  }

  const state = generateState();
  const callbackUrl = `http://localhost:${port}/callback`;

  // Build manifest with redirect_url embedded
  const manifest = buildManifest(parsed?.owner, callbackUrl);
  const manifestJson = JSON.stringify(manifest);
  const landingHtml = buildLandingPage(manifestJson, state);

  // Start local callback server
  const result = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);

      // Route: / → landing page with self-submitting POST form
      if (reqUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(landingHtml);
        return;
      }

      // Route: /callback → GitHub redirects here with code
      if (reqUrl.pathname === '/callback') {
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');

        if (returnedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<html><body><h1>状态验证失败</h1><p>请重试授权流程。</p></body></html>',
          );
          server.close();
          reject(new Error('State mismatch'));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<html><body><h1>授权失败</h1><p>未收到授权码。</p></body></html>',
          );
          server.close();
          reject(new Error('No code received'));
          return;
        }

        try {
          console.log('→ 正在交换授权码...');
          const appConfig = await exchangeManifestCode(code);
          resolve({ appConfig, res, server });
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<html><body><h1>交换失败</h1><p>${err.message}</p></body></html>`,
          );
          server.close();
          reject(err);
        }
        return;
      }

      // 404 for everything else
      res.writeHead(404);
      res.end();
    });

    const landingUrl = `http://localhost:${port}/`;

    server.listen(port, '127.0.0.1', () => {
      console.log('→ 正在打开浏览器...\n');
      console.log(
        '  如果浏览器未自动打开，请手动复制以下 URL：',
      );
      console.log(`  ${landingUrl}\n`);
      console.log('→ 等待用户授权...\n');

      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('浏览器将打开 pr-forge 授权页面：');
      console.log('');
      console.log(`  App 名称: ${manifest.name}`);
      console.log('  权限、回调地址等已自动预填。');
      console.log('');
      console.log('  你只需要：');
      console.log('  1. 查看页面上的 App 配置确认无误');
      console.log('  2. 点击 "前往 GitHub 创建 App" 按钮');
      console.log('  3. 在 GitHub 页面点击 Create GitHub App');
      console.log('  4. 无需手动修改任何字段');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      const opened = openBrowser(landingUrl);
      if (!opened) {
        console.log(
          '⚠️  无法自动打开浏览器，请手动复制上面的 URL 到浏览器。\n',
        );
      }
    });

    server.on('error', (err) => {
      reject(err);
    });

    // Timeout
    setTimeout(() => {
      server.close();
      reject(new Error('授权超时（2 分钟），请重试。'));
    }, TIMEOUT_MS);
  });

  const { appConfig, res, server } = result;
  const appId = appConfig.id;
  const privateKey = appConfig.pem;

  // Save credentials
  saveCredentials({ appId, privateKey });
  console.log(`\n✓ App ID: ${appId}`);
  console.log('✓ 凭据已保存到 ~/.pr-forge/credentials');

  // Generate mcp.json
  generateMcpJson(projectRoot, 'pr-forge');
  console.log('✓ .claude/mcp.json 已更新');

  // Respond success to browser, then redirect to install page
  const installUrl = `https://github.com/settings/apps/${appConfig.slug || `pr-forge`}/installations`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<html>
<head><meta charset="utf-8"><title>授权成功</title></head>
<body style="font-family:system-ui;max-width:480px;margin:40px auto;text-align:center">
  <h1 style="color:#2da44e">授权成功</h1>
  <p><strong>pr-forge</strong> GitHub App 已创建并保存。</p>
  <p style="color:#656d76">App ID: ${appId}</p>
  <p style="margin-top:24px">正在跳转到安装页面...</p>
  <p style="color:#656d76;font-size:13px">如未自动跳转，<a href="${installUrl}">点击这里</a></p>
  <script>setTimeout(function(){ location.href = "${installUrl}"; }, 1500);</script>
</body>
</html>`,
  );
  server.close();

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✓ GitHub App 授权完成！');
  console.log('');
  console.log('  浏览器将自动跳转到安装页面，选择仓库后点击 Install 即可。');
  console.log(`  安装地址: ${installUrl}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

export { authCommand };
