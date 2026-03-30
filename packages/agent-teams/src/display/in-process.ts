import type { Team } from '../team.js';
import type { TeamEvent } from '../types.js';

// ─── ANSI helpers ─────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
};

const BLOCK_FULL = '\u2588'; // █
const BLOCK_LIGHT = '\u2591'; // ░

/**
 * In-process display renderer with polished terminal output.
 */
export class InProcessDisplay {
  private team: Team;
  private unsubscribe?: () => void;
  private showOutput: boolean;

  // ─── State ─────────────────────────────────────────────────
  private runningTasks = new Map<string, { taskTitle: string; startTime: number }>();
  private teammateStats = new Map<string, {
    name: string;
    tasksCompleted: number;
    totalTimeMs: number;
    tasks: string[];
  }>();
  private totalTasks = 0;
  private completedTasks = 0;
  private failedTasks = 0;
  private teamStartTime = 0;
  private stoppedTeammates = new Set<string>();
  /** Buffer spawned names so we can print them on one line. */
  private spawnedNames: string[] = [];
  private spawnFlushTimer?: ReturnType<typeof setTimeout>;
  /** Suppress the redundant "claimed" line when run_start follows immediately. */
  private pendingClaim: { ts: string; name: string; title: string } | null = null;
  private claimFlushTimer?: ReturnType<typeof setTimeout>;
  /** Original stderr.write, saved during mute. */
  private origStderrWrite?: typeof process.stderr.write;
  /** Periodic status ticker interval. */
  private tickerInterval?: ReturnType<typeof setInterval>;
  /** Last ticker line length, for clearing. */
  private lastTickerLen = 0;

  constructor(team: Team, options?: { showOutput?: boolean }) {
    this.team = team;
    this.showOutput = options?.showOutput ?? false;
  }

  start(): void {
    this.unsubscribe = this.team.on((event) => this.handleEvent(event));
    this.muteStderr();
  }

  stop(): void {
    this.stopTicker();
    this.flushSpawned();
    this.flushClaim();
    this.unsubscribe?.();
    this.unmuteStderr();
  }

  // ─── Periodic status ticker ─────────────────────────────────

  private startTicker(): void {
    if (this.tickerInterval) return;
    this.tickerInterval = setInterval(() => this.printTicker(), 15_000);
  }

  private stopTicker(): void {
    if (this.tickerInterval) {
      clearInterval(this.tickerInterval);
      this.tickerInterval = undefined;
    }
    this.clearTicker();
  }

  private clearTicker(): void {
    if (this.lastTickerLen > 0) {
      // Clear the previous ticker line
      process.stdout.write(`\r${' '.repeat(this.lastTickerLen)}\r`);
      this.lastTickerLen = 0;
    }
  }

  private printTicker(): void {
    if (this.runningTasks.size === 0) return;

    const done = this.completedTasks + this.failedTasks;
    const total = this.totalTasks;
    const elapsed = this.teamStartTime ? this.fmtDuration(Date.now() - this.teamStartTime) : '';

    const active = Array.from(this.runningTasks.entries()).map(([id, info]) => {
      const secs = ((Date.now() - info.startTime) / 1000).toFixed(0);
      const name = this.teammateStats.get(id)?.name || id;
      return `${name}(${secs}s)`;
    });

    // Build a single-line status (no newline — will be overwritten)
    const line = `  ⏳ ${done}/${total} done · ${active.join(', ')} · ${elapsed}`;

    this.clearTicker();
    process.stdout.write(line);
    this.lastTickerLen = line.length;
  }

  /**
   * Suppress stderr output from child processes (e.g. bash tool errors)
   * to prevent them from polluting the display.
   */
  private muteStderr(): void {
    this.origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: any, ...args: any[]): boolean => {
      // Only suppress known bash/shell noise patterns
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      if (
        str.includes('/bin/bash:') ||
        str.includes('/bin/sh:') ||
        str.includes('command not found') ||
        str.includes('syntax error near unexpected token')
      ) {
        return true; // swallow
      }
      // Let real errors (Node.js, unhandled rejections, etc.) through
      return this.origStderrWrite!(chunk, ...args as [any, any]);
    };
  }

  private unmuteStderr(): void {
    if (this.origStderrWrite) {
      process.stderr.write = this.origStderrWrite;
      this.origStderrWrite = undefined;
    }
  }

  toggleOutput(): void {
    this.showOutput = !this.showOutput;
    this.log(`${c.dim}  [verbose output ${this.showOutput ? 'ON' : 'OFF'}]${c.reset}`);
  }

  // ─── Event handler ────────────────────────────────────────────

  private handleEvent(event: TeamEvent): void {
    // Flush buffered spawn names before any non-spawn event
    if (event.type !== 'teammate:spawned' && this.spawnedNames.length > 0) {
      this.flushSpawned();
    }

    const ts = this.fmtTime(event.timestamp);

    switch (event.type) {
      // ── Spawning ──────────────────────────────────────────
      case 'teammate:spawned':
        this.initStats(event.data.id, event.data.name);
        this.spawnedNames.push(event.data.name);
        // Batch spawns that fire within the same tick
        if (this.spawnFlushTimer) clearTimeout(this.spawnFlushTimer);
        this.spawnFlushTimer = setTimeout(() => this.flushSpawned(), 50);
        break;

      case 'teammate:stopped':
        if (this.stoppedTeammates.has(event.data.id)) break;
        this.stoppedTeammates.add(event.data.id);
        // silent — final stats table shows everything
        break;

      case 'teammate:idle':
        // Only show if it's genuinely done (max_idle_reached), not normal waiting
        if (event.data.reason === 'max_idle_reached') {
          this.log(`  ${c.yellow}⏸${c.reset}  ${event.data.name} ${c.dim}timed out idle${c.reset}`);
        }
        break;

      // ── Task lifecycle ────────────────────────────────────
      case 'task:created':
        this.totalTasks++;
        break;

      case 'task:claimed':
        // Buffer: if run_start arrives right after, we merge them
        this.flushClaim(); // flush any previous
        this.pendingClaim = { ts, name: event.data.teammateName, title: event.data.taskTitle };
        this.claimFlushTimer = setTimeout(() => this.flushClaim(), 100);
        break;

      case 'teammate:run_start': {
        // Merge with pending claim → single line
        if (this.claimFlushTimer) clearTimeout(this.claimFlushTimer);
        this.pendingClaim = null;

        this.runningTasks.set(event.data.id, { taskTitle: event.data.taskTitle, startTime: event.timestamp });
        this.log(`  ${c.cyan}▶${c.reset}  ${c.bold}${this.padName(event.data.name)}${c.reset} ${c.dim}→${c.reset} ${event.data.taskTitle}`);
        break;
      }

      case 'teammate:run_end': {
        this.runningTasks.delete(event.data.id);
        this.updateStats(event.data.id, event.data.taskTitle, event.data.durationMs);
        const sec = this.fmtDuration(event.data.durationMs);
        this.log(`  ${c.green}✓${c.reset}  ${c.bold}${this.padName(event.data.name)}${c.reset} ${event.data.taskTitle} ${c.dim}${sec}${c.reset}`);
        break;
      }

      case 'teammate:output':
        if (this.showOutput) {
          process.stdout.write(event.data.text);
        }
        break;

      case 'task:completed':
        this.completedTasks++;
        this.printProgressBar();
        break;

      case 'task:failed':
        this.failedTasks++;
        this.log(`  ${c.red}✗${c.reset}  ${c.bold}${event.data.taskTitle}${c.reset} ${c.red}FAILED${c.reset} ${c.dim}${event.data.error}${c.reset}`);
        this.printProgressBar();
        break;

      // ── Phase & Team lifecycle ─────────────────────────────
      case 'team:phase':
        this.log(`\n  ${c.bold}${c.cyan}[${event.data.phase}]${c.reset} ${c.bold}${event.data.label}${c.reset}\n`);
        break;

      case 'team:started':
        this.teamStartTime = event.timestamp;
        this.startTicker();
        break;

      case 'team:completed':
        this.stopTicker();
        this.printFinalReport(event.data.stats);
        break;

      case 'team:cleanup':
        break;
    }
  }

  // ─── Flush buffers ──────────────────────────────────────────

  private flushSpawned(): void {
    if (this.spawnFlushTimer) { clearTimeout(this.spawnFlushTimer); this.spawnFlushTimer = undefined; }
    if (this.spawnedNames.length === 0) return;

    const names = this.spawnedNames.map(n => `${c.blue}${n}${c.reset}`).join(`${c.dim}, ${c.reset}`);
    this.log(`  ${c.blue}●${c.reset}  Team: ${names}`);
    this.spawnedNames = [];
  }

  private flushClaim(): void {
    if (this.claimFlushTimer) { clearTimeout(this.claimFlushTimer); this.claimFlushTimer = undefined; }
    if (!this.pendingClaim) return;

    const { name, title } = this.pendingClaim;
    this.log(`  ${c.magenta}⤷${c.reset}  ${c.bold}${this.padName(name)}${c.reset} ${c.dim}claimed${c.reset} ${title}`);
    this.pendingClaim = null;
  }

  // ─── Progress bar ──────────────────────────────────────────

  private printProgressBar(): void {
    const total = this.totalTasks;
    if (total === 0) return;

    const done = this.completedTasks + this.failedTasks;
    const pct = Math.round((done / total) * 100);
    const barLen = 24;
    const filled = Math.round((done / total) * barLen);
    const bar = `${c.green}${BLOCK_FULL.repeat(filled)}${c.reset}${c.dim}${BLOCK_LIGHT.repeat(barLen - filled)}${c.reset}`;

    // Active teammates with elapsed time
    const active = Array.from(this.runningTasks.entries()).map(([id, info]) => {
      const elapsed = ((Date.now() - info.startTime) / 1000).toFixed(0);
      const name = this.teammateStats.get(id)?.name || id;
      return `${c.cyan}${name}${c.reset}${c.dim}(${elapsed}s)${c.reset}`;
    });

    const activeStr = active.length > 0 ? `  ${active.join(' ')}` : '';
    this.log(`\n  ${bar}  ${c.bold}${done}${c.reset}${c.dim}/${total} (${pct}%)${c.reset}${activeStr}\n`);
  }

  // ─── Final report ──────────────────────────────────────────

  printFinalReport(stats: { total: number; completed: number; failed: number }): void {
    const elapsed = this.teamStartTime ? this.fmtDuration(Date.now() - this.teamStartTime) : '?';

    this.log('');
    this.log(`  ${c.bold}${c.green}━━━ Results ━━━${c.reset} ${c.dim}${elapsed} total${c.reset}`);
    this.log('');

    // Summary
    const parts: string[] = [`${stats.total} tasks`];
    if (stats.completed > 0) parts.push(`${c.green}${stats.completed} done${c.reset}`);
    if (stats.failed > 0) parts.push(`${c.red}${stats.failed} failed${c.reset}`);
    this.log(`  ${parts.join(`${c.dim} · ${c.reset}`)}`);
    this.log('');

    // Per-teammate table
    if (this.teammateStats.size > 0) {
      const entries = Array.from(this.teammateStats.values())
        .sort((a, b) => b.tasksCompleted - a.tasksCompleted);

      // Find max name length for alignment
      const maxName = Math.max(...entries.map(e => e.name.length), 8);

      this.log(`  ${c.dim}${'─'.repeat(maxName + 20)}${c.reset}`);

      for (const entry of entries) {
        const name = entry.name.padEnd(maxName);
        const taskCount = String(entry.tasksCompleted).padStart(2);
        const time = this.fmtDuration(entry.totalTimeMs).padStart(8);

        // Mini bar based on time proportion
        const maxTime = Math.max(...entries.map(e => e.totalTimeMs));
        const barWidth = 8;
        const proportion = maxTime > 0 ? Math.max(1, Math.round((entry.totalTimeMs / maxTime) * barWidth)) : 0;
        const miniBar = `${c.green}${'█'.repeat(proportion)}${c.reset}${c.dim}${'░'.repeat(barWidth - proportion)}${c.reset}`;

        this.log(`  ${c.bold}${name}${c.reset}  ${taskCount} tasks  ${miniBar}  ${c.dim}${time}${c.reset}`);
      }

      this.log(`  ${c.dim}${'─'.repeat(maxName + 20)}${c.reset}`);
      this.log('');
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  private fmtDuration(ms: number): string {
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const remSec = (sec % 60).toFixed(0);
    return `${min}m${remSec}s`;
  }

  private padName(name: string): string {
    return name.padEnd(8);
  }

  private initStats(id: string, name: string): void {
    if (!this.teammateStats.has(id)) {
      this.teammateStats.set(id, { name, tasksCompleted: 0, totalTimeMs: 0, tasks: [] });
    }
  }

  private updateStats(id: string, taskTitle: string, durationMs: number): void {
    const s = this.teammateStats.get(id);
    if (s) {
      s.tasksCompleted++;
      s.totalTimeMs += durationMs;
      s.tasks.push(taskTitle);
    }
  }

  private log(msg: string): void {
    this.clearTicker();
    process.stdout.write(msg + '\n');
  }
}
