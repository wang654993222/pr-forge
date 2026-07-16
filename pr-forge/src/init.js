import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const PROJECT_DETECTORS = [
  { files: ['pom.xml', 'mvnw'], type: 'Java (Maven Wrapper)', defaultPhases: [{ id: 'java-verify', name: 'Java 验证', check: './mvnw compile -q && ./mvnw test' }] },
  { files: ['pom.xml'], type: 'Java (Maven)', defaultPhases: [{ id: 'java-verify', name: 'Java 验证', check: 'mvn compile -q && mvn test' }] },
  { files: ['build.gradle', 'gradlew'], type: 'Java (Gradle Wrapper)', defaultPhases: [{ id: 'java-verify', name: 'Java 验证', check: './gradlew check' }] },
  { files: ['build.gradle'], type: 'Java (Gradle)', defaultPhases: [{ id: 'java-verify', name: 'Java 验证', check: 'gradle check' }] },
  { files: ['package.json'], type: 'Node.js', defaultPhases: [{ id: 'js-verify', name: 'Node.js 验证', check: 'npm run lint && npm test' }] },
  { files: ['Cargo.toml'], type: 'Rust', defaultPhases: [{ id: 'rust-verify', name: 'Rust 验证', check: 'cargo test && cargo clippy' }] },
  { files: ['go.mod'], type: 'Go', defaultPhases: [{ id: 'go-verify', name: 'Go 验证', check: 'go vet ./... && go test ./...' }] },
  { files: ['pyproject.toml'], type: 'Python', defaultPhases: [{ id: 'py-verify', name: 'Python 验证', check: 'pytest -q && ruff check .' }] },
];

function detectAllProjectTypes(projectRoot) {
  const detectedTypes = [];
  for (const detector of PROJECT_DETECTORS) {
    if (detector.files.every((f) => fs.existsSync(path.join(projectRoot, f)))) {
      detectedTypes.push(detector);
    }
  }
  return detectedTypes;
}

function mergePhases(detectedTypes) {
  const phases = [];
  const seen = new Set();
  for (const dt of detectedTypes) {
    for (const p of dt.defaultPhases || []) {
      if (!seen.has(p.id)) { seen.add(p.id); phases.push({ ...p }); }
    }
  }
  return phases;
}

function generateConfig(projectRoot, defaultPhases) {
  const config = {
    version: '3.0',
    timeout: 300,
    phases: defaultPhases || [],
  };
  const prForgeDir = path.join(projectRoot, '.pr-forge');
  fs.mkdirSync(prForgeDir, { recursive: true });
  const configPath = path.join(prForgeDir, 'config.json');
  const configContent = JSON.stringify(config, null, 2) + '\n';
  fs.writeFileSync(configPath, configContent);
  const hash = createHash('sha256').update(configContent).digest('hex');
  fs.writeFileSync(path.join(prForgeDir, '.approved'), hash);
  return config;
}

function readCredentials() {
  const credPath = path.join(homedir(), '.pr-forge', 'credentials');
  if (fs.existsSync(credPath)) {
    try { return JSON.parse(fs.readFileSync(credPath, 'utf-8')); } catch { return null; }
  }
  return null;
}

function saveCredentials(data) {
  const credDir = path.join(homedir(), '.pr-forge');
  fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
  const credPath = path.join(credDir, 'credentials');
  fs.writeFileSync(credPath, JSON.stringify({ ...data, created_at: data.created_at || new Date().toISOString() }), { mode: 0o600 });
}

function hasAppCredentials() {
  const creds = readCredentials();
  return !!(creds?.appId && creds?.privateKey);
}

function buildMcpEnv() {
  const creds = readCredentials();
  const env = {};
  if (creds?.token) env.PR_FORGE_TOKEN = creds.token;
  if (creds?.appId && creds?.privateKey) {
    env.PR_FORGE_GITHUB_APP_ID = String(creds.appId);
    env.PR_FORGE_GITHUB_APP_PRIVATE_KEY = creds.privateKey;
    if (creds.installationId) env.PR_FORGE_GITHUB_APP_INSTALLATION_ID = String(creds.installationId);
  }
  return env;
}

function generateCodexMcpJson(packageName) {
  const tmpPluginsDir = path.join(homedir(), '.codex', '.tmp', 'plugins');
  const pluginDir = path.join(tmpPluginsDir, 'plugins', 'pr-forge');
  const pluginJsonDir = path.join(pluginDir, '.codex-plugin');
  fs.mkdirSync(pluginJsonDir, { recursive: true });

  // Clean up old config.toml entry from v3.1 TOML bug
  const tomlPath = path.join(homedir(), '.codex', 'config.toml');
  if (fs.existsSync(tomlPath)) {
    let toml = fs.readFileSync(tomlPath, 'utf-8');
    const idx = toml.indexOf('\n[mcp_servers.pr-forge]');
    if (idx !== -1) {
      const after = toml.substring(idx + 1);
      const nextMatch = after.match(/\n\[(?!mcp_servers\.pr-forge\.)/);
      toml = toml.substring(0, idx) + (nextMatch ? after.substring(nextMatch.index) : '');
      toml = toml.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
      fs.writeFileSync(tomlPath, toml);
    }
  }

  const pluginJson = {
    name: 'pr-forge',
    version: '3.1.0',
    description: 'AI Code Review Gateway — Agent must pass PR review before merge',
    author: { name: 'pr-forge' },
    license: 'MIT',
    keywords: ['code-review', 'pr', 'github', 'gitee', 'mcp'],
    mcpServers: './.mcp.json',
    interface: {
      displayName: 'PR Forge',
      shortDescription: 'AI-driven PR review with automated checks and merge gating',
      longDescription: 'pr-forge adds a safety gate before AI code changes are merged. Every PR must pass automated checks (lint/test/build) before an AI reviewer can approve and merge.',
      developerName: 'pr-forge',
      category: 'Developer Tools',
      capabilities: ['Read', 'Write', 'Interactive'],
    },
  };
  fs.writeFileSync(path.join(pluginJsonDir, 'plugin.json'), JSON.stringify(pluginJson, null, 2) + '\n');

  const env = buildMcpEnv();
  const isWin = process.platform === 'win32';
  const mcpJson = {
    mcpServers: {
      'pr-forge': {
        command: isWin ? 'cmd' : 'npx',
        args: isWin ? ['/c', 'npx', '-y', packageName || 'pr-forge'] : ['-y', packageName || 'pr-forge'],
        env,
      },
    },
  };
  fs.writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify(mcpJson, null, 2) + '\n');

  // Register in the personal marketplace so Codex discovers the plugin
  const bundledMarketplaceDir = path.join(homedir(), '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled', '.agents', 'plugins');
  fs.mkdirSync(bundledMarketplaceDir, { recursive: true });
  const marketplacePath = path.join(bundledMarketplaceDir, 'marketplace.json');
  let marketplace = { name: 'openai-bundled', interface: { displayName: 'Codex marketplace' }, plugins: [] };
  if (fs.existsSync(marketplacePath)) {
    let raw = fs.readFileSync(marketplacePath, 'utf-8');
    // Strip UTF-8 BOM if present (PowerShell/Windows encoding artifact)
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    marketplace = JSON.parse(raw);
  }
  marketplace.plugins = marketplace.plugins.filter(p => p.name !== 'pr-forge');
  marketplace.plugins.push({
    name: 'pr-forge',
    source: { source: 'local', path: './plugins/pr-forge' },
    policy: { installation: 'INSTALLED', authentication: 'NONE' },
    category: 'Developer Tools',
  });
  fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
  // Ensure computer-use stays DISABLED — Codex auto-loads AVAILABLE plugins
  // and computer-use can break the agent experience
  const cu = marketplace.plugins.find(p => p.name === 'computer-use');
  if (cu && cu.policy) cu.policy.installation = 'DISABLED';
  fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
}

function generateMcpJson(projectRoot, packageName) {
  const mcpJsonPath = path.join(projectRoot, '.claude');
  fs.mkdirSync(mcpJsonPath, { recursive: true });
  const env = buildMcpEnv();
  const isWin = process.platform === 'win32';
  const mcpConfig = {
    mcpServers: {
      'pr-forge': {
        command: isWin ? 'cmd' : 'npx',
        args: isWin ? ['/c', 'npx', '-y', packageName || 'pr-forge'] : ['-y', packageName || 'pr-forge'],
        env,
      },
    },
  };
  const filePath = path.join(mcpJsonPath, 'mcp.json');
  fs.writeFileSync(filePath, JSON.stringify(mcpConfig, null, 2) + '\n');

  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entries = ['.claude/mcp.json', '.pr-forge/'];
  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
  }
  let added = false;
  for (const entry of entries) {
    if (!gitignoreContent.includes(entry)) {
      gitignoreContent += (gitignoreContent && !gitignoreContent.endsWith('\n') ? '\n' : '') + entry + '\n';
      added = true;
    }
  }
  if (added) fs.writeFileSync(gitignorePath, gitignoreContent);
}

function checkV2Install(projectRoot) {
  return fs.existsSync(path.join(projectRoot, 'mcp-server', 'pr-forge', 'server.py'));
}

export {
  detectAllProjectTypes, mergePhases, generateConfig,
  saveCredentials, readCredentials, hasAppCredentials, buildMcpEnv,
  generateCodexMcpJson, generateMcpJson, checkV2Install,
  PROJECT_DETECTORS,
};
