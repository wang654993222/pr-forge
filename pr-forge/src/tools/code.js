import { error } from '../error-codes.js';

async function get_pr_diff(params, platform) {
  const { pr_number, max_bytes } = params;

  if (!pr_number || pr_number < 1) {
    return error('PR_NOT_FOUND');
  }

  try {
    const diff = await platform.getDiff(pr_number);
    const result = {
      ok: true,
      diff_bytes: Buffer.byteLength(diff, 'utf-8'),
    };

    if (max_bytes && max_bytes > 0 && diff.length > max_bytes) {
      result.diff = diff.slice(0, max_bytes);
      result.truncated = true;
    } else {
      result.diff = diff;
    }

    return result;
  } catch (e) {
    if (e.code) return error(e.code);
    return error('NETWORK_ERROR');
  }
}

async function get_file_content(params, platform) {
  const { path: filePath, ref, max_bytes } = params;

  if (!filePath || typeof filePath !== 'string') {
    return error('INVALID_PATH');
  }

  if (filePath.includes('..')) {
    return error('INVALID_PATH');
  }

  try {
    const content = await platform.getFileContent(filePath, ref || undefined);
    const limit = max_bytes && max_bytes > 0 ? max_bytes : 512000;
    const result = {
      ok: true,
      content_bytes: Buffer.byteLength(content, 'utf-8'),
    };

    if (content.length > limit) {
      result.content = content.slice(0, limit);
      result.truncated = true;
    } else {
      result.content = content;
    }

    return result;
  } catch (e) {
    if (e.code) return error(e.code);
    if (e.message && e.message.includes('404')) {
      return error('FILE_NOT_FOUND');
    }
    return error('NETWORK_ERROR');
  }
}

export { get_pr_diff, get_file_content };
