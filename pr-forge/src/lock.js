import fs from 'node:fs';
import path from 'node:path';

function lockPath(projectRoot, prNumber) {
  return path.join(projectRoot, '.pr-forge', 'locks', `pr-${prNumber}.lock`);
}

function isLockHeldByDeadProcess(pidStr) {
  try {
    process.kill(Number(pidStr), 0);
    return false;
  } catch {
    return true;
  }
}

function acquireLock(projectRoot, prNumber) {
  const lp = lockPath(projectRoot, prNumber);
  fs.mkdirSync(path.dirname(lp), { recursive: true });

  try {
    fs.writeFileSync(lp, String(process.pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      const existingPid = fs.readFileSync(lp, 'utf-8').trim();
      if (isLockHeldByDeadProcess(existingPid)) {
        fs.unlinkSync(lp);
        return acquireLock(projectRoot, prNumber);
      }
      return false;
    }
    throw err;
  }
}

function releaseLock(projectRoot, prNumber) {
  const lp = lockPath(projectRoot, prNumber);
  try {
    fs.unlinkSync(lp);
  } catch {
    // lock doesn't exist, no-op
  }
}

export { acquireLock, releaseLock, isLockHeldByDeadProcess };
