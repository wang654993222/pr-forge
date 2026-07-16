import { getProjectRoot, getPlatformInfo, resolvePlatform, getCurrentBranch } from './context.js';
import { loadConfig, verifyConfig } from './config.js';
import { get_pr_context } from './tools/context.js';
import { get_review_plan, get_review_status } from './tools/review.js';
import { get_pr_diff, get_file_content } from './tools/code.js';
import { commit_and_push } from './tools/git.js';
import { run_pr_checks } from './tools/checks.js';
import { set_conclusion, merge_pr } from './tools/conclusion.js';
import { acquireLock, releaseLock } from './lock.js';
import { execSync } from 'node:child_process';

const DEBUG = process.env.PR_FORGE_DEBUG === '1';

function debug(toolName, params, result) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [${toolName}] params=${JSON.stringify(params)} → result=${JSON.stringify(result)}\n`);
}

const TOOLS = [
  {
    name: 'get_pr_context',
    description: '获取 PR 元数据（title/state/draft/SHA/branch/author）',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'get_review_status',
    description: '读取各 phase Check Run 结论 + 完整审查报告（含聚合状态）',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'get_pr_diff',
    description: '获取 PR unified diff',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
        max_bytes: { type: 'number', description: '最大返回字节数（可选）' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'get_file_content',
    description: '获取仓库文件内容',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对于仓库根目录）' },
        ref: { type: 'string', description: '分支或 commit SHA（可选）' },
        max_bytes: { type: 'number', description: '最大返回字节数（可选，默认 512000）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'commit_and_push',
    description: '提交修复并推送到 PR 分支',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'commit 消息' },
        pr_number: { type: 'number', description: 'PR 编号（与 branch 二选一）' },
        branch: { type: 'string', description: '分支名（与 pr_number 二选一）' },
        files: { type: 'array', items: { type: 'string' }, description: '要提交的文件（可选，默认 -A）' },
      },
      required: ['message'],
    },
  },
  {
    name: 'merge_pr',
    description: '合并 PR（两层门禁：事实层聚合 + 审查意见）',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: '合并方式' },
        acknowledge: { type: 'boolean', description: '确认审查意见中的风险（neutral 时必传 true）' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'run_pr_checks',
    description: '执行 config.json 的 check 命令（多阶段），各 phase 独立写 Check Run',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
        phase: { type: 'string', description: '指定 phase id（可选，不传执行全部）' },
        timeout: { type: 'number', description: '超时秒数（可选，覆盖 config 全局值）' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'set_conclusion',
    description: '修改 Check Run 整体结论，附带审查报告',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号' },
        conclusion: { type: 'string', enum: ['success', 'failure', 'neutral'], description: '审查结论' },
        report_text: { type: 'string', description: '审查报告（Markdown）' },
      },
      required: ['pr_number', 'conclusion'],
    },
  },
  {
    name: 'get_review_plan',
    description: '动态生成审查步骤清单（无参数自动找最新 open PR）',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'PR 编号（可选）' },
        branch: { type: 'string', description: '分支名（可选）' },
      },
      required: [],
    },
  },
];

class PrFlowServer {
  constructor() {
    this.projectRoot = getProjectRoot();
    this.platformInfo = getPlatformInfo(process.env);
    this.platform = this.platformInfo ? resolvePlatform(process.env) : null;
    this.config = loadConfig(this.projectRoot);
  }

  async handleToolCall(name, params) {
    const env = process.env;
    const startTime = DEBUG ? Date.now() : 0;

    let result;
    try {
      switch (name) {
        case 'get_pr_context':
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else result = await get_pr_context(params, this.platform);
          break;

        case 'get_review_status':
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else result = await get_review_status(params, this.platform);
          break;

        case 'get_pr_diff':
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else result = await get_pr_diff(params, this.platform);
          break;

        case 'get_file_content':
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else result = await get_file_content(params, this.platform);
          break;

        case 'commit_and_push': {
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else {
            const git = { execSync };
            result = await commit_and_push(params, git, this.platform);
          }
          break;
        }

        case 'merge_pr':
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else result = await merge_pr(params, this.platform);
          break;

        case 'run_pr_checks': {
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else {
            const context = {
              projectRoot: this.projectRoot,
              verifyConfig: () => verifyConfig(this.projectRoot),
              acquireLock: () => acquireLock(this.projectRoot, params.pr_number),
              releaseLock: () => releaseLock(this.projectRoot, params.pr_number),
            };
            const git = { execSync };
            result = await run_pr_checks(params, this.config, this.platform, context, git);
          }
          break;
        }

        case 'set_conclusion':
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else result = await set_conclusion(params, this.platform);
          break;

        case 'get_review_plan': {
          if (!this.platform) result = { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Platform not configured' } };
          else {
            // Resolve branch → pr_number when branch is provided but pr_number is not
            let resolvedParams = { ...params };
            if (resolvedParams.branch && !resolvedParams.pr_number) {
              try {
                const prs = await this.platform.listPRs('open', resolvedParams.branch);
                if (prs.length > 0) {
                  resolvedParams.pr_number = prs[0].number;
                } else {
                  result = { ok: false, error: { code: 'PR_NOT_FOUND', message: `未找到分支 ${resolvedParams.branch} 对应的 open PR` } };
                  break;
                }
              } catch {
                result = { ok: false, error: { code: 'NETWORK_ERROR', message: '无法获取 PR 列表' } };
                break;
              }
            }
            // Handle auto-detect (no pr_number or branch)
            if (!resolvedParams.pr_number && !resolvedParams.branch) {
              const branch = getCurrentBranch();
              if (branch && !['main', 'master'].includes(branch)) {
                resolvedParams.branch = branch;
                try {
                  const prs = await this.platform.listPRs('open', resolvedParams.branch);
                  if (prs.length > 0) {
                    resolvedParams.pr_number = prs[0].number;
                  }
                } catch {
                  // Fall through to pr_number-less handling
                }
              }
              if (!resolvedParams.pr_number) {
                try {
                  const prs = await this.platform.listPRs('open');
                  if (prs.length > 0) {
                    resolvedParams.pr_number = prs[0].number;
                  } else {
                    result = { ok: false, error: { code: 'NO_PULL_REQUEST', message: '没有 open PR' } };
                    break;
                  }
                } catch {
                  result = { ok: false, error: { code: 'NO_PULL_REQUEST', message: '无法获取 PR 列表' } };
                  break;
                }
              }
            }
            result = await get_review_plan(resolvedParams, this.platform, this.config);
          }
          break;
        }

        default:
          result = { ok: false, error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${name}` } };
      }
    } catch (e) {
      result = { ok: false, error: { code: 'INTERNAL_ERROR', message: e.message } };
    }

    if (DEBUG) {
      const duration_ms = Date.now() - startTime;
      const ok = result?.ok === true;
      debug(name, params, { ok, duration_ms });
    }

    return result;
  }

  getTools() {
    return TOOLS;
  }
}

async function startServer() {
  const server = new PrFlowServer();
  const rl = readlineFromStdin();

  for await (const line of rl) {
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'pr-forge', version: '3.0.0' },
            capabilities: { tools: {} },
          },
        }) + '\n');
      } else if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { tools: server.getTools() },
        }) + '\n');
      } else if (msg.method === 'tools/call') {
        const result = await server.handleToolCall(
          msg.params.name,
          msg.params.arguments || {}
        );
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
        }) + '\n');
      } else if (msg.method === 'notifications/initialized') {
        // no response needed
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // JSON parse error — reply with JSON-RPC compliant error
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }) + '\n');
      } else {
        process.stderr.write(`pr-forge error: ${e.message}\n`);
      }
    }
  }
}

function readlineFromStdin() {
  const rl = {
    async *[Symbol.asyncIterator]() {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk.toString());
        const data = chunks.join('');
        const lines = data.split('\n');
        chunks.splice(0, chunks.length, lines[lines.length - 1]);
        if (lines.length > 1) {
          for (const line of lines.slice(0, -1)) {
            if (line.trim()) yield line.trim();
          }
        }
      }
    },
  };
  return rl;
}

export { startServer, PrFlowServer, TOOLS };
