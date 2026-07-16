#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);

if (args[0] === 'init') {
  const { initCommand } = await import('./cli-init.js');
  await initCommand(args.slice(1));
} else if (args[0] === 'auth') {
  const { authCommand } = await import('./cli-auth.js');
  await authCommand(args.slice(1));
} else if (args[0] === 'doctor') {
  const { doctorCommand } = await import('./cli-doctor.js');
  await doctorCommand(args.slice(1));
} else if (args[0] === '--version' || args[0] === '-v') {
  const pkg = JSON.parse(await import('fs').then((fs) => fs.default.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')));
  console.log(pkg.version);
} else {
  // Default: start MCP server
  const { startServer } = await import('./server.js');
  await startServer();
}
