import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const RUNTIME_REPO_ROOT_ENV = 'PULSE_CODER_RUNTIME_REPO_ROOT';

export async function alignProcessCwdToGitRepoRoot(): Promise<string | undefined> {
  const repoRoot = await resolveGitRepoRoot(process.cwd());
  if (!repoRoot) {
    return undefined;
  }

  process.env[RUNTIME_REPO_ROOT_ENV] = repoRoot;

  if (process.cwd() !== repoRoot) {
    process.chdir(repoRoot);
  }

  return repoRoot;
}

export function getRuntimeRepoRoot(): string | undefined {
  const fromEnv = process.env[RUNTIME_REPO_ROOT_ENV]?.trim();
  if (!fromEnv) {
    return undefined;
  }

  return fromEnv;
}

async function resolveGitRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });

    const repoRoot = stdout.trim();
    return repoRoot || undefined;
  } catch {
    return undefined;
  }
}
