import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function configPath(projectRoot) {
  return path.join(projectRoot, '.pr-forge', 'config.json');
}

function approvedPath(projectRoot) {
  return path.join(projectRoot, '.pr-forge', '.approved');
}

function loadConfig(projectRoot) {
  const cp = configPath(projectRoot);
  if (!fs.existsSync(cp)) return null;
  const raw = JSON.parse(fs.readFileSync(cp, 'utf-8'));

  if (raw.check && !raw.phases) {
    raw.phases = [{ id: 'default', name: '验证', check: raw.check }];
    delete raw.check;
  }

  const globalTimeout = raw.timeout || 300;
  for (const phase of raw.phases || []) {
    if (phase.timeout === undefined) phase.timeout = globalTimeout;
  }

  return raw;
}

function verifyConfig(projectRoot) {
  const cp = configPath(projectRoot);
  const ap = approvedPath(projectRoot);
  if (!fs.existsSync(cp)) return null;
  if (!fs.existsSync(ap)) return null;
  const content = fs.readFileSync(cp, 'utf-8');
  const currentHash = createHash('sha256').update(content).digest('hex');
  const approvedHash = fs.readFileSync(ap, 'utf-8').trim();
  return currentHash === approvedHash;
}

function writeApproved(projectRoot) {
  const cp = configPath(projectRoot);
  const ap = approvedPath(projectRoot);
  const content = fs.readFileSync(cp, 'utf-8');
  const hash = createHash('sha256').update(content).digest('hex');
  fs.mkdirSync(path.dirname(ap), { recursive: true });
  fs.writeFileSync(ap, hash);
}

function getConfigHash(projectRoot) {
  const cp = configPath(projectRoot);
  if (!fs.existsSync(cp)) return null;
  return createHash('sha256').update(fs.readFileSync(cp, 'utf-8')).digest('hex');
}

export { loadConfig, verifyConfig, writeApproved, getConfigHash };
