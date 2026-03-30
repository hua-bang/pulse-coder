import type { Team, TeamEvent } from 'pulse-coder-agent-teams';

// ─── ANSI Colors ──────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgGray: '\x1b[100m',
};

/**
 * In-process display renderer.
 * Shows team status, task progress, and teammate output with colors and progress bar.
 */
export class InProcessDisplay {
  private team: Team;
  private unsubscribe?: () => void;
  private showOutput: boolean;

  /** Track running tasks per teammate */
  private runningTasks = new Map<string, { taskTitle: string; startTime: number }>();
  /** Track per-teammate stats */
  private teammateStats = new Map<string, { name: string; tasksCompleted: number; totalTimeMs: number; tasks: string[] }>();
  /** Track total task count and progress */
  private totalTasks = 0;
  private completedTasks = 0;
  private failedTasks = 0;
  /** Team start time */
  private teamStartTime = 0;
  /** Already-stopped teammates to avoid duplicate logs */
  private stoppedTeammates = new Set<string>();

  constructor(team: Team, options?: { showOutput?: boolean }) {
    this.team = team;
    this.showOutput = options?.showOutput ?? false;
  }

  start(): void {
    this.unsubscribe = this.team.on((event) => this.handleEvent(event));
    this.printHeader();
  }

  stop(): void {
    this.unsubscribe?.();
  }

  cycleNext(): void {
    const members = this.team.members;
    if (members.length === 0) return;
  }

  toggleOutput(): void {
    this.showOutput = !this.showOutput;
    this.log(`${c.gray}[display] Output streaming ${this.showOutput ? 'ON' : 'OFF'}${c.reset}`);
  }

  // ─── Internal ────────────────────────────────────────────────────

  private handleEvent(event: TeamEvent): void {
    const ts = this.formatTime(event.timestamp);

    switch (event.type) {
      case 'teammate:spawned':
        this.initTeammateStats(event.data.id, event.data.name);
        this.log(`${c.gray}${ts}${c.reset} ${c.blue}●${c.reset} ${c.bold}${event.data.name}${c.reset} ${c.dim}joined the team${c.reset}`);
        break;

      case 'teammate:stopped':
        // Deduplicate
        if (this.stoppedTeammates.has(event.data.id)) break;
        this.stoppedTeammates.add(event.data.id);
        this.log(`${c.gray}${ts}${c.reset} ${c.dim}○ ${event.data.name} left the team${c.reset}`);
        break;

      case 'teammate:idle':
        this.log(`${c.gray}${ts}${c.reset} ${c.yellow}⏸${c.reset} ${event.data.name} ${c.dim}idle (${event.data.reason})${c.reset}`);
        break;

      case 'teammate:run_start':
        this.runningTasks.set(event.data.id, { taskTitle: event.data.taskTitle, startTime: event.timestamp });
        this.log(`${c.gray}${ts}${c.reset} ${c.cyan}▶${c.reset} ${c.bold}${event.data.name}${c.reset} → ${event.data.taskTitle}`);
        break;

      case 'teammate:run_end': {
        this.runningTasks.delete(event.data.id);
        const sec = (event.data.durationMs / 1000).toFixed(1);
        this.updateTeammateStats(event.data.id, event.data.taskTitle, event.data.durationMs);
        this.log(`${c.gray}${ts}${c.reset} ${c.green}■${c.reset} ${c.bold}${event.data.name}${c.reset} ✓ ${event.data.taskTitle} ${c.dim}(${sec}s)${c.reset}`);
        break;
      }

      case 'teammate:output':
        if (this.showOutput) {
          process.stdout.write(event.data.text);
        }
        break;

      case 'task:created':
        this.totalTasks++;
        break;

      case 'task:claimed':
        this.log(`${c.gray}${ts}${c.reset} ${c.magenta}⤷${c.reset} ${event.data.teammateName} claimed: ${event.data.taskTitle}`);
        break;

      case 'task:completed':
        this.completedTasks++;
        this.printProgress();
        break;

      case 'task:failed':
        this.failedTasks++;
        this.log(`${c.gray}${ts}${c.reset} ${c.red}✗ ${event.data.taskTitle} FAILED${c.reset}: ${event.data.error}`);
        this.printProgress();
        break;

      case 'team:started':
        this.teamStartTime = event.timestamp;
        break;

      case 'team:completed':
        this.printFinalStats(event.data.stats);
        break;

      case 'team:cleanup':
        break;
    }
  }

  private printHeader(): void {
    this.log('');
    this.log(`${c.bold}${'━'.repeat(60)}${c.reset}`);
    this.log(`${c.bold}  🤖 Pulse Agent Teams${c.reset} ${c.dim}— ${this.team.name}${c.reset}`);
    this.log(`${c.bold}${'━'.repeat(60)}${c.reset}`);
    this.log('');
  }

  private printProgress(): void {
    const total = this.totalTasks;
    if (total === 0) return;

    const done = this.completedTasks + this.failedTasks;
    const pct = Math.round((done / total) * 100);
    const barLen = 20;
    const filled = Math.round((done / total) * barLen);
    const bar = `${c.bgGreen}${' '.repeat(filled)}${c.reset}${c.bgGray}${' '.repeat(barLen - filled)}${c.reset}`;

    // Active teammates
    const active = Array.from(this.runningTasks.entries()).map(([id, info]) => {
      const elapsed = ((Date.now() - info.startTime) / 1000).toFixed(0);
      const name = this.teammateStats.get(id)?.name || id;
      return `${name}(${elapsed}s)`;
    });

    const activeStr = active.length > 0 ? `  ${c.cyan}Active: ${active.join(', ')}${c.reset}` : '';
    this.log(`  ${bar} ${c.bold}${done}/${total}${c.reset} ${c.dim}(${pct}%)${c.reset}${activeStr}`);
  }

  private printFinalStats(stats: { total: number; completed: number; failed: number }): void {
    const elapsed = this.teamStartTime ? ((Date.now() - this.teamStartTime) / 1000).toFixed(1) : '?';

    this.log('');
    this.log(`${c.bold}${'━'.repeat(60)}${c.reset}`);
    this.log(`${c.bold}  📊 Team Run Complete${c.reset} ${c.dim}(${elapsed}s total)${c.reset}`);
    this.log(`${c.bold}${'━'.repeat(60)}${c.reset}`);
    this.log('');

    // Summary line
    const completedStr = stats.completed > 0 ? `${c.green}${stats.completed} completed${c.reset}` : '0 completed';
    const failedStr = stats.failed > 0 ? `${c.red}${stats.failed} failed${c.reset}` : '';
    this.log(`  Tasks: ${stats.total} total, ${completedStr}${failedStr ? ', ' + failedStr : ''}`);
    this.log('');

    // Per-teammate table
    if (this.teammateStats.size > 0) {
      this.log(`  ${c.bold}${c.dim}Teammate${' '.repeat(16)}Tasks   Time${c.reset}`);
      this.log(`  ${c.dim}${'─'.repeat(44)}${c.reset}`);

      const entries = Array.from(this.teammateStats.values())
        .sort((a, b) => b.tasksCompleted - a.tasksCompleted);

      for (const entry of entries) {
        const name = entry.name.padEnd(22);
        const tasks = String(entry.tasksCompleted).padStart(3);
        const time = `${(entry.totalTimeMs / 1000).toFixed(1)}s`;
        this.log(`  ${c.bold}${name}${c.reset} ${tasks}   ${c.dim}${time}${c.reset}`);
      }
      this.log('');
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private initTeammateStats(id: string, name: string): void {
    if (!this.teammateStats.has(id)) {
      this.teammateStats.set(id, { name, tasksCompleted: 0, totalTimeMs: 0, tasks: [] });
    }
  }

  private updateTeammateStats(id: string, taskTitle: string, durationMs: number): void {
    const stats = this.teammateStats.get(id);
    if (stats) {
      stats.tasksCompleted++;
      stats.totalTimeMs += durationMs;
      stats.tasks.push(taskTitle);
    }
  }

  private log(msg: string): void {
    process.stdout.write(msg + '\n');
  }
}
