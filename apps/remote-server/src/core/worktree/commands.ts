import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { promisify } from 'util';
import { worktreeService } from './integration.js';

const COMMAND_PREFIX = '/wt';
const MAX_PATH_LENGTH = 400;
const BRANCH_PREFIXES = ['feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'hotfix'];
const execFileAsync = promisify(execFile);

export interface WorktreeCommandResult {
  handled: boolean;
  message?: string;
}

interface ParsedTokens {
  command: string;
  args: string[];
}

interface UpdateBindingInput {
  runtimeKey: string;
  scopeKey: string;
  id: string;
  repoRoot: string;
  worktreePath: string;
  branch?: string;
}

export async function processWorktreeCommand(input: {
  text: string;
  runtimeKey: string;
  scopeKey: string;
}): Promise<WorktreeCommandResult> {
  const raw = input.text.trim();
  if (!raw.startsWith(COMMAND_PREFIX)) {
    return { handled: false };
  }

  const tokens = parseTokens(raw);
  if (!tokens) {
    return {
      handled: true,
      message: buildHelpMessage(),
    };
  }

  switch (tokens.command) {
    case 'help':
      return {
        handled: true,
        message: buildHelpMessage(),
      };

    case 'status': {
      const binding = await worktreeService.getScopeBinding({
        runtimeKey: input.runtimeKey,
        scopeKey: input.scopeKey,
      });

      if (!binding) {
        return {
          handled: true,
          message: [
            '🧭 当前没有绑定 worktree。',
            '使用 `/wt use <id> <repoRoot> <worktreePath> [branch]` 绑定。',
          ].join('\n'),
        };
      }

      const lines = [
        '🧭 当前 worktree 绑定：',
        `- id: ${binding.worktree.id}`,
        `- repoRoot: ${binding.worktree.repoRoot}`,
        `- worktreePath: ${binding.worktree.worktreePath}`,
      ];

      if (binding.worktree.branch) {
        lines.push(`- branch: ${binding.worktree.branch}`);
      }

      return {
        handled: true,
        message: lines.join('\n'),
      };
    }

    case 'use': {
      if (tokens.args.length === 1) {
        const rawId = tokens.args[0]?.trim() ?? '';
        if (!rawId) {
          return {
            handled: true,
            message: '❌ id 不能为空。',
          };
        }

        const normalizedId = normalizeWorktreeId(rawId);
        if (!normalizedId) {
          return {
            handled: true,
            message: '❌ id 不能为空。',
          };
        }

        const existing = await findExistingWorktree(rawId, normalizedId);
        if (!existing) {
          const created = await createWorktreeIfMissing(normalizedId);
          if (!created.ok) {
            return {
              handled: true,
              message: created.reason,
            };
          }

          const binding = await worktreeService.upsertAndBind(
            {
              runtimeKey: input.runtimeKey,
              scopeKey: input.scopeKey,
            },
            {
              id: created.value.id,
              repoRoot: created.value.repoRoot,
              worktreePath: created.value.worktreePath,
              branch: created.value.branch,
            },
          );

          return {
            handled: true,
            message: buildBindingMessage(binding, true),
          };
        }

        if (existing.repoRoot.length > MAX_PATH_LENGTH || existing.worktreePath.length > MAX_PATH_LENGTH) {
          return {
            handled: true,
            message: '❌ 路径过长，请缩短后重试。',
          };
        }

        const binding = await worktreeService.upsertAndBind(
          {
            runtimeKey: input.runtimeKey,
            scopeKey: input.scopeKey,
          },
          {
            id: existing.id,
            repoRoot: existing.repoRoot,
            worktreePath: existing.worktreePath,
            branch: existing.branch,
          },
        );

        return {
          handled: true,
          message: buildBindingMessage(binding, false),
        };
      }

      const parseResult = parseUseArgs(tokens.args);
      if (!parseResult.ok) {
        return {
          handled: true,
          message: parseResult.reason,
        };
      }

      const binding = await worktreeService.upsertAndBind(
        {
          runtimeKey: input.runtimeKey,
          scopeKey: input.scopeKey,
        },
        {
          id: parseResult.value.id,
          repoRoot: parseResult.value.repoRoot,
          worktreePath: parseResult.value.worktreePath,
          branch: parseResult.value.branch,
        },
      );

      return {
        handled: true,
        message: buildBindingMessage(binding, false),
      };
    }

    case 'clear': {
      const result = await worktreeService.clearScopeBinding({
        runtimeKey: input.runtimeKey,
        scopeKey: input.scopeKey,
      });

      if (!result.ok) {
        return {
          handled: true,
          message: '❌ 清除绑定失败，请稍后重试。',
        };
      }

      if (!result.cleared) {
        return {
          handled: true,
          message: 'ℹ️ 当前没有 worktree 绑定。',
        };
      }

      return {
        handled: true,
        message: `🧹 已清除绑定：${result.cleared.worktreeId}`,
      };
    }

    default:
      return {
        handled: true,
        message: `⚠️ 未知子命令：${tokens.command}\n\n${buildHelpMessage()}`,
      };
  }
}

export async function updateScopeWorktreeBinding(input: UpdateBindingInput): Promise<void> {
  await worktreeService.upsertAndBind(
    {
      runtimeKey: input.runtimeKey,
      scopeKey: input.scopeKey,
    },
    {
      id: input.id,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      branch: input.branch,
    },
  );
}

function parseTokens(raw: string): ParsedTokens | null {
  const tokens = raw.split(/\s+/g).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const command = tokens[1]?.trim() ?? 'help';
  return {
    command,
    args: tokens.slice(2),
  };
}

function parseUseArgs(args: string[]):
  | { ok: true; value: { id: string; repoRoot: string; worktreePath: string; branch?: string } }
  | { ok: false; reason: string } {
  if (args.length < 3) {
    return {
      ok: false,
      reason: '❌ 参数不足\n用法：/wt use <id> <repoRoot> <worktreePath> [branch]',
    };
  }

  const id = args[0]?.trim() ?? '';
  const repoRoot = args[1]?.trim() ?? '';
  const worktreePath = args[2]?.trim() ?? '';
  const branch = args[3]?.trim();

  if (!id || !repoRoot || !worktreePath) {
    return {
      ok: false,
      reason: '❌ id/repoRoot/worktreePath 不能为空。',
    };
  }

  if (repoRoot.length > MAX_PATH_LENGTH || worktreePath.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      reason: '❌ 路径过长，请缩短后重试。',
    };
  }

  return {
    ok: true,
    value: {
      id,
      repoRoot,
      worktreePath,
      branch,
    },
  };
}

function buildHelpMessage(): string {
  return [
    '🧩 Worktree 命令：',
    '/wt status - 查看当前会话绑定的 worktree',
    '/wt use <id> - 复用已有或创建新的 worktree 并绑定',
    '/wt use <id> <repoRoot> <worktreePath> [branch] - 绑定/更新当前会话 worktree',
    '/wt clear - 清除当前会话 worktree 绑定',
  ].join('\n');
}

async function findExistingWorktree(rawId: string, normalizedId: string) {
  const direct = await worktreeService.getWorktree(rawId);
  if (direct) {
    return direct;
  }

  if (normalizedId !== rawId) {
    return worktreeService.getWorktree(normalizedId);
  }

  return undefined;
}

async function createWorktreeIfMissing(id: string): Promise<
  | { ok: true; value: { id: string; repoRoot: string; worktreePath: string; branch: string } }
  | { ok: false; reason: string }
> {
  const repoRoot = await resolveRepoRoot();
  if (!repoRoot) {
    return {
      ok: false,
      reason: '❌ 无法解析仓库根目录，请设置 PULSE_CODER_REPO_ROOT 或使用完整参数。',
    };
  }

  const worktreeRoot = resolveWorktreeRoot(repoRoot);
  const worktreePath = join(worktreeRoot, `wt-${id}`);
  if (worktreePath.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      reason: '❌ 路径过长，请缩短后重试。',
    };
  }

  const pathExists = await exists(worktreePath);
  if (pathExists) {
    return {
      ok: false,
      reason: `❌ worktree 目录已存在：${worktreePath}\n请更换 id 或手动清理。`,
    };
  }

  const branch = resolveBranchName(id);
  try {
    await fs.mkdir(worktreeRoot, { recursive: true });
    await runGit(repoRoot, ['fetch', 'origin'], true);

    const branchExists = await gitRefExists(repoRoot, `refs/heads/${branch}`);
    if (branchExists) {
      await runGit(repoRoot, ['worktree', 'add', worktreePath, branch]);
    } else {
      const baseRef = await resolveBaseRef(repoRoot);
      if (!baseRef) {
        return {
          ok: false,
          reason: '❌ 无法找到 base 分支（origin/main/master 或 main/master）。',
        };
      }
      await runGit(repoRoot, ['worktree', 'add', worktreePath, '-b', branch, baseRef]);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `❌ 创建 worktree 失败：${formatError(err)}`,
    };
  }

  return {
    ok: true,
    value: {
      id,
      repoRoot,
      worktreePath,
      branch,
    },
  };
}

async function resolveRepoRoot(): Promise<string | null> {
  const fromEnv = process.env.PULSE_CODER_REPO_ROOT?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel']);
    const root = stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

function resolveWorktreeRoot(repoRoot: string): string {
  const fromEnv = process.env.PULSE_CODER_WORKTREE_ROOT?.trim();
  if (fromEnv) {
    return resolvePath(repoRoot, fromEnv);
  }

  return join(repoRoot, 'worktrees');
}

async function resolveBaseRef(repoRoot: string): Promise<string | null> {
  const candidates = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];
  for (const ref of candidates) {
    if (await gitRefExists(repoRoot, ref)) {
      return ref.replace(/^refs\//, '');
    }
  }
  return null;
}

function resolveBranchName(slug: string): string {
  if (BRANCH_PREFIXES.some((prefix) => slug.startsWith(`${prefix}-`))) {
    return slug.replace(/^([a-z0-9]+)-/, '$1/');
  }
  return `feat/${slug}`;
}

function normalizeWorktreeId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

async function runGit(repoRoot: string, args: string[], ignoreFailure = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args]);
    return stdout.trim();
  } catch (err) {
    if (ignoreFailure) {
      return '';
    }
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function buildBindingMessage(
  binding: { worktree: { id: string; repoRoot: string; worktreePath: string; branch?: string } },
  created: boolean,
): string {
  const lines = [created ? '✅ 已创建并绑定 worktree。' : '✅ 已更新 worktree 绑定。'];
  lines.push(`- id: ${binding.worktree.id}`);
  lines.push(`- repoRoot: ${binding.worktree.repoRoot}`);
  lines.push(`- worktreePath: ${binding.worktree.worktreePath}`);
  if (binding.worktree.branch) {
    lines.push(`- branch: ${binding.worktree.branch}`);
  }
  return lines.join('\n');
}
