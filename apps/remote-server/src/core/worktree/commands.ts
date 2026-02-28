import { execFile } from 'child_process';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { worktreeService } from './integration.js';

const COMMAND_PREFIX = '/wt';
const MAX_PATH_LENGTH = 400;
const MAX_WORKTREE_ID_LENGTH = 80;
const DEFAULT_WORKTREE_DIR = 'worktrees';
const DEFAULT_WORKTREE_PREFIX = 'wt-';
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

interface ParsedUseArgsValue {
  id: string;
  repoRoot: string;
  worktreePath: string;
  branch?: string;
  autoCreated?: boolean;
  baseRef?: string;
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
            '推荐：`/wt use <branch>` 自动创建并绑定。',
            '手动：`/wt use <id> <repoRoot> <worktreePath> [branch]`。',
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
      const parseResult = await parseUseArgs(tokens.args);
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

      const lines = [
        '✅ 已更新 worktree 绑定。',
        `- id: ${binding.worktree.id}`,
        `- repoRoot: ${binding.worktree.repoRoot}`,
        `- worktreePath: ${binding.worktree.worktreePath}`,
      ];

      if (binding.worktree.branch) {
        lines.push(`- branch: ${binding.worktree.branch}`);
      }

      if (parseResult.value.autoCreated !== undefined) {
        lines.push(`- autoCreate: ${parseResult.value.autoCreated ? 'yes' : 'no (already exists)'}`);
      }
      if (parseResult.value.baseRef) {
        lines.push(`- baseRef: ${parseResult.value.baseRef}`);
      }

      return {
        handled: true,
        message: lines.join('\n'),
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

export async function clearScopeWorktreeBinding(input: { runtimeKey: string; scopeKey: string }): Promise<void> {
  await worktreeService.clearScopeBinding({
    runtimeKey: input.runtimeKey,
    scopeKey: input.scopeKey,
  });
}

function parseTokens(raw: string): ParsedTokens | null {
  const parts = raw.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0 || parts[0].toLowerCase() !== COMMAND_PREFIX) {
    return null;
  }

  const command = (parts[1] ?? 'help').toLowerCase();
  const args = parts.slice(2);
  return { command, args };
}

async function parseUseArgs(args: string[]): Promise<
  | { ok: true; value: ParsedUseArgsValue }
  | { ok: false; reason: string }
> {
  if (args.length === 1 || args.length === 2) {
    return parseAutoUseArgs(args);
  }

  if (args.length < 3) {
    return {
      ok: false,
      reason: [
        '❌ 参数不足',
        '推荐用法：/wt use <branch> [baseRef]',
        '手动用法：/wt use <id> <repoRoot> <worktreePath> [branch]',
      ].join('\n'),
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
      branch: branch || undefined,
    },
  };
}

async function parseAutoUseArgs(args: string[]): Promise<
  | { ok: true; value: ParsedUseArgsValue }
  | { ok: false; reason: string }
> {
  const branch = args[0]?.trim() ?? '';
  const providedBaseRef = args[1]?.trim() || undefined;

  if (!branch) {
    return {
      ok: false,
      reason: '❌ branch 不能为空。用法：/wt use <branch> [baseRef]',
    };
  }

  let repoRoot = '';
  try {
    repoRoot = await resolveGitRepoRoot();
  } catch {
    return {
      ok: false,
      reason: '❌ 无法自动定位 git 项目根目录，请改用手动模式：/wt use <id> <repoRoot> <worktreePath> [branch]',
    };
  }

  const branchValid = await isValidGitBranchName(repoRoot, branch);
  if (!branchValid) {
    return {
      ok: false,
      reason: `❌ 非法分支名：${branch}`,
    };
  }

  const id = branchToWorktreeId(branch);
  if (!id) {
    return {
      ok: false,
      reason: `❌ 无法从分支名生成合法 worktree id：${branch}`,
    };
  }

  const worktreeRoot = join(repoRoot, DEFAULT_WORKTREE_DIR);
  const worktreePath = join(worktreeRoot, `${DEFAULT_WORKTREE_PREFIX}${id}`);
  if (worktreePath.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      reason: '❌ 自动生成的 worktree 路径过长，请使用手动模式。',
    };
  }

  const existing = await hasWorktreePath(repoRoot, worktreePath);
  let created = false;
  let baseRefUsed: string | undefined;

  if (!existing) {
    try {
      await mkdir(worktreeRoot, { recursive: true });
      const branchExists = await hasLocalBranch(repoRoot, branch);
      if (branchExists) {
        await runGit(repoRoot, ['worktree', 'add', worktreePath, branch]);
      } else {
        const baseRef = providedBaseRef || await resolveDefaultBaseRef(repoRoot);
        await runGit(repoRoot, ['worktree', 'add', worktreePath, '-b', branch, baseRef]);
        baseRefUsed = baseRef;
      }
      created = true;
    } catch (error) {
      return {
        ok: false,
        reason: `❌ 自动创建 worktree 失败：${extractExecErrorMessage(error)}`,
      };
    }
  }

  return {
    ok: true,
    value: {
      id,
      repoRoot,
      worktreePath,
      branch,
      autoCreated: created,
      baseRef: baseRefUsed,
    },
  };
}

async function resolveGitRepoRoot(): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });

  const repoRoot = stdout.trim();
  if (!repoRoot) {
    throw new Error('empty repo root');
  }
  return repoRoot;
}

async function resolveDefaultBaseRef(repoRoot: string): Promise<string> {
  const originHead = await tryRunGit(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead && originHead.startsWith('refs/remotes/')) {
    return originHead.slice('refs/remotes/'.length);
  }

  if (await gitRefExists(repoRoot, 'refs/remotes/origin/main')) {
    return 'origin/main';
  }
  if (await gitRefExists(repoRoot, 'refs/remotes/origin/master')) {
    return 'origin/master';
  }
  if (await gitRefExists(repoRoot, 'refs/heads/main')) {
    return 'main';
  }
  if (await gitRefExists(repoRoot, 'refs/heads/master')) {
    return 'master';
  }

  return 'HEAD';
}

async function hasWorktreePath(repoRoot: string, worktreePath: string): Promise<boolean> {
  const output = await tryRunGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!output) {
    return false;
  }

  const normalizedTarget = normalizePathForCompare(worktreePath);
  for (const line of output.split('\n')) {
    if (!line.startsWith('worktree ')) {
      continue;
    }

    const candidatePath = line.slice('worktree '.length).trim();
    if (normalizePathForCompare(candidatePath) === normalizedTarget) {
      return true;
    }
  }

  return false;
}

async function hasLocalBranch(repoRoot: string, branch: string): Promise<boolean> {
  return gitRefExists(repoRoot, `refs/heads/${branch}`);
}

async function isValidGitBranchName(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ['check-ref-format', '--branch', branch]);
    return true;
  } catch {
    return false;
  }
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ['show-ref', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

async function runGit(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });

  return stdout.trim();
}

async function tryRunGit(repoRoot: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(repoRoot, args);
  } catch {
    return null;
  }
}

function branchToWorktreeId(branch: string): string {
  return branch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_WORKTREE_ID_LENGTH);
}

function normalizePathForCompare(value: string): string {
  return value.replace(/\/+$/, '');
}

function extractExecErrorMessage(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return 'unknown error';
  }

  const candidate = error as {
    stderr?: string;
    stdout?: string;
    message?: string;
    code?: number | string;
  };

  const stderr = candidate.stderr?.trim();
  if (stderr) {
    return stderr;
  }

  const stdout = candidate.stdout?.trim();
  if (stdout) {
    return stdout;
  }

  if (candidate.message) {
    return candidate.message;
  }

  if (candidate.code !== undefined) {
    return `exit code ${String(candidate.code)}`;
  }

  return 'unknown error';
}

function buildHelpMessage(): string {
  return [
    '🧩 Worktree 命令：',
    '/wt status - 查看当前会话绑定的 worktree',
    '/wt use <branch> [baseRef] - 自动创建并绑定（推荐）',
    '/wt use <id> <repoRoot> <worktreePath> [branch] - 手动绑定/更新',
    '/wt clear - 清除当前会话 worktree 绑定',
  ].join('\n');
}
