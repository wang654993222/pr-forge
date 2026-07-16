#!/usr/bin/env node
// pr-forge auth — PAT → GitHub App 升级专用
// 新用户请使用: npx pr-forge init
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import {
  saveCredentials, readCredentials,
  generateMcpJson, generateCodexToml,
} from './init.js';
import { createAppJWT, validateApp } from './platforms/github.js';

const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 120_000;

function getGitRemote() {
  try { return execSync('git config --get remote.origin.url', { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
  catch { return null; }
}

function parseGitRemote(remote) {
  const match = remote?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

function buildManifest(owner, redirectUrl) {
  const name = `pr-forge${owner ? `-${owner}` : ''}`;
  return { name, url: 'https://github.com/wang654993222/pr-forge', description: 'AI Code Review Gateway', public: false, redirect_url: redirectUrl, default_permissions: { checks: 'write', pull_requests: 'write', contents: 'write', metadata: 'read' }, default_events: [] };
}

function escapeHtml(str) { return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function buildLandingPage(manifestJson, state) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>pr-forge — 创建 GitHub App</title></head><body style="font-family:system-ui;max-width:560px;margin:40px auto;padding:0 20px"><h1>pr-forge GitHub App 授权</h1><p>以下 App 配置已自动预填。</p><pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:16px;overflow-x:auto;font-size:13px">${escapeHtml(JSON.stringify(JSON.parse(manifestJson), null, 2))}</pre><form id="f" method="POST" action="https://github.com/settings/apps/new" style="margin-top:24px"><input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}" /><input type="hidden" name="state" value="${state}" /><button type="submit" style="background:#2da44e;color:#fff;border:none;padding:12px 24px;font-size:16px;border-radius:6px;cursor:pointer">前往 GitHub 创建 App →</button></form></body></html>`;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.listen(0, 'localhost', () => { const p = server.address().port; server.close(() => resolve(p)); }); server.on('error', reject);
  });
}

async function exchangeManifestCode(code) {
  const res = await fetch(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!res.ok) { const body = await res.text(); if (body.includes('Marketplace')) throw new Error('请先接受 GitHub Marketplace Developer Agreement。'); throw new Error(`Manifest exchange failed: HTTP ${res.status}`); }
  return res.json();
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: 'ignore' }); return true; } catch { return false; }
}

async function authCommand(_args) {
  const projectRoot = process.cwd();
  console.log('\npr-forge GitHub App 授权 (PAT → App 升级)\n');
  console.log('提示：新用户请使用 npx pr-forge init\n');

  const existing = readCredentials();
  if (existing?.appId && existing?.privateKey) {
    console.log('→ 检测到已有 GitHub App 凭据，正在验证...');
    const jwt = createAppJWT(existing.appId, existing.privateKey);
    if (jwt && await validateApp(jwt)) {
      console.log(`✓ App #${existing.appId} 有效，直接复用\n`);
      generateMcpJson(projectRoot, 'pr-forge'); console.log('✓ .claude/mcp.json 已更新');
      generateCodexToml('pr-forge'); console.log('✓ Codex config.toml 已生成');
      console.log('\n✓ 配置完成！\n'); process.exit(0);
    }
    console.log('⚠️  已有凭证无效，将重新授权。\n');
  }

  const remote = getGitRemote(); const parsed = remote ? parseGitRemote(remote) : null;
  if (parsed) console.log(`✓ 检测到仓库: ${parsed.owner}/${parsed.repo}`);

  let port; try { port = await findFreePort(); } catch { console.error('✗ 无法启动本地回调服务器。'); process.exit(1); }

  const state = randomBytes(16).toString('hex');
  const callbackUrl = `http://localhost:${port}/callback`;
  const manifest = buildManifest(parsed?.owner, callbackUrl);
  const manifestJson = JSON.stringify(manifest);
  const landingHtml = buildLandingPage(manifestJson, state);

  const result = await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      if (reqUrl.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(landingHtml); return; }
      if (reqUrl.pathname === '/callback') {
        const code = reqUrl.searchParams.get('code');
        if (reqUrl.searchParams.get('state') !== state) { res.writeHead(400); res.end('State mismatch'); server.close(); reject(new Error('State mismatch')); return; }
        if (!code) { res.writeHead(400); res.end('No code'); server.close(); reject(new Error('No code')); return; }
        try { console.log('→ 正在交换授权码...'); const appConfig = await exchangeManifestCode(code); resolve({ appConfig, res, server }); }
        catch (err) { res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<html><body><h1>交换失败</h1><p>${err.message}</p></body></html>`); server.close(); reject(err); }
        return;
      }
      res.writeHead(404); res.end();
    });
    const landingUrl = `http://localhost:${port}/`;
    server.listen(port, '127.0.0.1', () => { console.log('→ 正在打开浏览器...\n'); const opened = openBrowser(landingUrl); if (!opened) console.log(`⚠️  请手动打开: ${landingUrl}\n`); });
    server.on('error', reject);
    setTimeout(() => { server.close(); reject(new Error('授权超时')); }, TIMEOUT_MS);
  });

  const { appConfig, res, server } = result;
  saveCredentials({ appId: appConfig.id, privateKey: appConfig.pem });
  console.log(`\n✓ App ID: ${appConfig.id}`); console.log('✓ 凭据已保存到 ~/.pr-forge/credentials');
  generateMcpJson(projectRoot, 'pr-forge'); console.log('✓ .claude/mcp.json 已更新');
  generateCodexToml('pr-forge'); console.log('✓ Codex config.toml 已生成');

  const installUrl = `https://github.com/settings/apps/${appConfig.slug || 'pr-forge'}/installations`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<html><head><meta charset="utf-8"><title>授权成功</title></head><body style="font-family:system-ui;max-width:480px;margin:40px auto;text-align:center"><h1 style="color:#2da44e">授权成功</h1><p>App ID: ${appConfig.id}</p><p style="margin-top:24px">正在跳转到安装页面...</p><script>setTimeout(function(){ location.href = "${installUrl}"; }, 1500);</script></body></html>`);
  server.close();

  console.log(''); console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✓ GitHub App 授权完成！');
  console.log(`  安装地址: ${installUrl}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

export { authCommand };