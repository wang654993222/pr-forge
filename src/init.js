import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const PROJECT_DETECTORS = [
  { files: ['pom.xml', 'mvnw'], type: 'Java (Maven Wrapper)', defaultPhases: [{ id: 'verify', name: '验证', check: './mvnw compile -q && ./mvnw test' }] },
  { files: ['pom.xml'], type: 'Java (Maven)', defaultPhases: [{ id: 'verify', name: '验证', check: 'mvn compile -q && mvn test' }] },
  { files: ['build.gradle', 'gradlew'], type: 'Java (Gradle Wrapper)', defaultPhases: [{ id: 'verify', name: '验证', check: './gradlew check' }] },
  { files: ['build.gradle'], type: 'Java (Gradle)', defaultPhases: [{ id: 'verify', name: '验证', check: 'gradle check' }] },
  { files: ['package.json'], type: 'Node.js', defaultPhases: [{ id: 'verify', name: '验证', check: 'npm run lint && npm test' }] },
  { files: ['Cargo.toml'], type: 'Rust', defaultPhases: [{ id: 'verify', name: '验证', check: 'cargo test && cargo clippy' }] },
  { files: ['go.mod'], type: 'Go', defaultPhases: [{ id: 'verify', name: '验证', check: 'go vet ./... && go test ./...' }] },
  { files: ['pyproject.toml'], type: 'Python', defaultPhases: [{ id: 'verify', name: '验证', check: 'pytest -q && ruff check .' }] },
];

function detectProjectType(projectRoot) {
  const detectedTypes = [];
  for (const detector of PROJECT_DETECTORS) {
    if (detector.files.every((f) => fs.existsSync(path.join(projectRoot, f)))) {
      detectedTypes.push(detector);
    }
  }

  if (detectedTypes.length > 1) {
    const types = detectedTypes.map((d) => d.type).join(', ');
    console.warn(`\n检测到多种项目类型（${types}），已默认选择 ${detectedTypes[0].type}。monorepo 项目请手动编辑 .pr-forge/config.json。\n`);
  }

  return detectedTypes[0] || { type: '通用模板', defaultPhases: null };
}

function generateConfig(projectRoot, defaultPhases) {
  const config = {
    version: '3.0',
    timeout: 300,
    phases: defaultPhases || [],
  };

  const prFlowDir = path.join(projectRoot, '.pr-forge');
  fs.mkdirSync(prFlowDir, { recursive: true });

  const configPath = path.join(prFlowDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  const hash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  fs.writeFileSync(path.join(prFlowDir, '.approved'), hash);

  return config;
}

function saveCredentials(token) {
  const credDir = path.join(homedir(), '.pr-forge');
  fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
  const credPath = path.join(credDir, 'credentials');
  fs.writeFileSync(credPath, JSON.stringify({ token, created_at: new Date().toISOString() }), { mode: 0o600 });
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

function generateMcpJson(projectRoot, packageName) {
  const mcpJsonPath = path.join(projectRoot, '.claude');
  fs.mkdirSync(mcpJsonPath, { recursive: true });

  const mcpConfig = {
    mcpServers: {
      'pr-forge': {
        command: 'npx',
        args: ['-y', packageName || 'pr-forge'],
        env: {
          PR_FLOW_TOKEN: readCredentials()?.token || '',
        },
      },
    },
  };

  const filePath = path.join(mcpJsonPath, 'mcp.json');
  fs.writeFileSync(filePath, JSON.stringify(mcpConfig, null, 2) + '\n');

  // Add to .gitignore
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const entry = '.claude/mcp.json';
  let gitignoreContent = '';
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
  }
  if (!gitignoreContent.includes(entry)) {
    fs.appendFileSync(gitignorePath, (gitignoreContent ? '\n' : '') + entry + '\n');
  }
}

function checkV2Install(projectRoot) {
  return fs.existsSync(path.join(projectRoot, 'mcp-server', 'pr-forge', 'server.py'));
}

export {
  detectProjectType,
  generateConfig,
  saveCredentials,
  readCredentials,
  generateMcpJson,
  checkV2Install,
  PROJECT_DETECTORS,
};
