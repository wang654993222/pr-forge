import * as readline from 'node:readline';
import { detectProjectType, generateConfig, saveCredentials, readCredentials, generateMcpJson, checkV2Install } from './init.js';

async function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

async function initCommand(args) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const projectRoot = process.cwd();
  console.log('\npr-forge v3.0 初始化\n');

  // Check v2 install
  if (checkV2Install(projectRoot)) {
    console.log('⚠️  检测到 pr-forge v2 安装。v2 Python 版已 EOL，init 将覆盖 mcp.json 配置。');
    console.log('   v2 审查数据通过向后兼容读取保持可访问。\n');
  }

  // Detect project type
  const projectType = detectProjectType(projectRoot);
  console.log(`✓ 检测到项目类型: ${projectType.type}`);

  if (projectType.defaultPhases) {
    console.log('  默认验证阶段:');
    projectType.defaultPhases.forEach((p) => {
      console.log(`    - ${p.id}: ${p.check}`);
    });
  } else {
    console.log('  ⚠️  未检测到已知项目类型，请手动编辑 .pr-forge/config.json');
  }

  console.log('');

  // Token
  let token;
  const existingCreds = readCredentials();
  if (existingCreds?.token) {
    console.log('✓ 检测到已有 token (~/.pr-forge/credentials)，直接复用');
    token = existingCreds.token;
  } else {
    const tokenArg = args.find((a) => a.startsWith('--token='));
    if (tokenArg) {
      token = tokenArg.split('=')[1];
    } else {
      token = await prompt(rl, '请输入平台 Token (GitHub/Gitee): ');
    }

    if (token) {
      saveCredentials(token);
      console.log('✓ Token 已备份到 ~/.pr-forge/credentials');
    }
  }

  // Generate config
  if (projectType.defaultPhases) {
    generateConfig(projectRoot, projectType.defaultPhases);
    console.log('✓ .pr-forge/config.json 已生成（含 .approved hash）');
  } else {
    // Generate empty config for manual editing
    generateConfig(projectRoot, []);
    console.log('✓ .pr-forge/config.json 已生成（空模板，请手动编辑）');
  }

  // Generate mcp.json
  if (token) {
    generateMcpJson(projectRoot, 'pr-forge');
    console.log('✓ .claude/mcp.json 已生成');
    console.log('\n⚠️  mcp.json 已加入 .gitignore，不要手动取消。');
  }

  console.log('\n✓ 初始化完成！现在可以告诉你的 Agent: "审查 PR #N"\n');

  rl.close();
}

export { initCommand };
