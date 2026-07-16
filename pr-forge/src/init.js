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
    try {
      return JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    } catch {
      return null;
    }
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

function generateCodexToml(packageName) {
  const codexDir = path.join(homedir(), '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const tomlPath = path.join(codexDir, 'config.toml');

  let existingToml = '';
  if (fs.existsSync(tomlPath)) {
    existingToml = fs.readFileSync(tomlPath, 'utf-8');
    if (existingToml.includes('[mcp_servers.pr-forge]')) {
      return; // already configured, skip
    }
  }

  const creds = readCredentials();
  let envBlock = '';
  if (creds?.appId && creds?.privateKey) {
    envBlock = `PR_FORGE_GITHUB_APP_ID = "${creds.appId}"\nPR_FORGE_GITHUB_APP_PRIVATE_KEY = '''\n${creds.privateKey}\n'''`;
    if (creds.installationId) envBlock += `\nPR_FORGE_GITHUB_APP_INSTALLATION_ID = "${creds.installationId}"`;
  } else if (creds?.token) {
    envBlock = `PR_FORGE_TOKEN = "${creds.token}"`;
  } else {
    envBlock = 'PR_FORGE_TOKEN = "<YOUR_TOKEN>"';
  }

  const tomlBlock = `\n[mcp_servers.pr-forge]\ncommand = 'pr-forge'\nargs = []\nstartup_timeout_sec = 120\n\n[mcp_servers.pr-forge.env]\n${envBlock}\n`;

  const sep = existingToml && !existingToml.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(tomlPath, existingToml + sep + tomlBlock);
}

function generateMcpJson(projectRoot, packageName) {
  const mcpJsonPath = path.join(projectRoot, '.claude');
  fs.mkdirSync(mcpJsonPath, { recursive: true });

  const env = buildMcpEnv();

  const mcpConfig = {
    mcpServers: {
      'pr-forge': {
        command: 'npx',
        args: ['-y', packageName || 'pr-forge'],
        env,
      },
    },
  };

  const filePath = path.join(mcpJsonPath, 'mcp.json');
  fs.writeFileSync(filePath, JSON.stringify(mcpConfig, null, 2) + '\n');

  // Add to .gitignore
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
  detectAllProjectTypes,
  mergePhases,
  generateConfig,
  saveCredentials,
  readCredentials,
  hasAppCredentials,
  buildMcpEnv,
  generateCodexToml,
  generateMcpJson,
  checkV2Install,
  PROJECT_DETECTORS,
};