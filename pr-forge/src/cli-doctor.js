import { runDoctor } from './doctor.js';

async function doctorCommand() {
  const projectRoot = process.cwd();
  console.log('\npr-forge 环境诊断\n');

  const result = await runDoctor(projectRoot, null);

  for (const check of result.checks) {
    const icon = check.pass ? '✓' : '✗';
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
  }

  console.log(`\n${result.allPass ? '✓ 所有检查通过' : '✗ 部分检查未通过，请根据上述提示修复'}\n`);

  if (!result.allPass) {
    process.exit(1);
  }
}

export { doctorCommand };
