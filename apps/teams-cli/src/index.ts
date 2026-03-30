import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Team, TeamLead } from 'pulse-coder-agent-teams';
import type { TeamConfig, TeammateOptions, CreateTaskInput, TeamPlan } from 'pulse-coder-agent-teams';
import { InProcessDisplay } from './display/in-process.js';

// ─── ANSI Colors ──────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
};

// ─── Logger (silent during run mode, only shows errors) ───────────

let loggerQuiet = false;

const logger = {
  debug(_msg: string) { /* always silent */ },
  info(msg: string) { if (!loggerQuiet) console.log(`${c.dim}[info]${c.reset} ${msg}`); },
  warn(msg: string) { if (!loggerQuiet) console.warn(`${c.yellow}[warn]${c.reset} ${msg}`); },
  error(msg: string, err?: Error) { console.error(`${c.red}[error]${c.reset} ${msg}`, err?.message || ''); },
};

// ─── CLI ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  switch (command) {
    case 'run':
      await runTeam(args.slice(1));
      break;
    case 'plan':
      await planOnly(args.slice(1));
      break;
    case 'interactive':
      await interactiveMode();
      break;
    default:
      // Treat the entire args as a task description
      await runTeam(args);
      break;
  }
}

// ─── Run mode (TeamLead automated flow) ────────────────────────────

async function runTeam(args: string[]) {
  const verbose = args.includes('--verbose') || args.includes('-v');

  // Parse --concurrency N
  let concurrency = 0; // 0 = unlimited
  const concIdx = args.indexOf('--concurrency');
  if (concIdx !== -1 && args[concIdx + 1]) {
    concurrency = parseInt(args[concIdx + 1], 10);
    if (isNaN(concurrency) || concurrency < 1) {
      console.error('Error: --concurrency must be a positive integer.');
      process.exit(1);
    }
  }

  const filteredArgs = args.filter((a, i) =>
    a !== '--verbose' && a !== '-v' &&
    a !== '--concurrency' && (concIdx === -1 || i !== concIdx + 1)
  );
  const taskDescription = filteredArgs.join(' ');

  if (!taskDescription) {
    console.error('Error: Please provide a task description.');
    console.error('Usage: pulse-teams run "Your task description" [--verbose]');
    process.exit(1);
  }

  // Suppress all logger noise during run — display handles the UI
  loggerQuiet = true;

  const teamName = `team-${Date.now()}`;
  const lead = new TeamLead({
    teamName,
    logger,
    defaultTeammateEngineOptions: { disableBuiltInPlugins: true },
  });

  const display = new InProcessDisplay(lead.team, { showOutput: verbose });
  display.start();

  try {
    await lead.initialize();

    // ── Header ──
    printBanner(taskDescription, concurrency);

    // ── Phase 1: Plan ──
    printPhase(1, 'Planning');
    const runStart = Date.now();

    const { plan, synthesis } = await lead.orchestrate(taskDescription, {
      concurrency,
      onPlan: async (plan) => {
        printPlan(plan);
        printPhase(2, `Spawning ${plan.teammates.length} teammates`);
        return true;
      },
    });

    // Phase 3 & 4 headers are shown by the display via events

    // ── Synthesis ──
    printPhase(5, 'Synthesis');
    console.log('');
    console.log(synthesis);
    console.log('');

    // ── Footer ──
    const totalSec = ((Date.now() - runStart) / 1000).toFixed(1);
    console.log(`${c.dim}  Done in ${totalSec}s${c.reset}`);
    console.log('');

    await lead.team.cleanup();
  } catch (err: any) {
    console.error(`\n${c.red}Team run failed:${c.reset} ${err.message}`);
    try { await lead.team.cleanup(); } catch { /* best effort */ }
    process.exit(1);
  } finally {
    display.stop();
    loggerQuiet = false;
  }
}

// ─── Plan-only mode ────────────────────────────────────────────────

async function planOnly(args: string[]) {
  const taskDescription = args.join(' ');
  if (!taskDescription) {
    console.error('Error: Please provide a task description.');
    process.exit(1);
  }

  const { planTeam } = await import('pulse-coder-agent-teams');

  printBanner(taskDescription);
  printPhase(1, 'Planning');
  const plan = await planTeam(taskDescription, { logger });
  printPlan(plan);
}

// ─── Interactive mode ──────────────────────────────────────────────

async function interactiveMode() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.cyan}teams>${c.reset} `,
  });

  let team: Team | null = null;
  let lead: TeamLead | null = null;
  let display: InProcessDisplay | null = null;

  console.log(`\n${c.bold}Pulse Agent Teams${c.reset} ${c.dim}— Interactive Mode${c.reset}`);
  console.log(`${c.dim}Type "help" for commands.${c.reset}\n`);

  rl.prompt();

  rl.on('line', async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];
    const rest = parts.slice(1).join(' ');

    try {
      switch (cmd) {
        case 'create': {
          const name = rest || `team-${Date.now()}`;
          lead = new TeamLead({
            teamName: name,
            logger,
            defaultTeammateEngineOptions: { disableBuiltInPlugins: true },
          });
          await lead.initialize();
          team = lead.team;
          display = new InProcessDisplay(team);
          display.start();
          console.log(`${c.green}✓${c.reset} Team "${name}" created.`);
          break;
        }

        case 'spawn': {
          if (!team) { console.log('Create a team first: create <name>'); break; }
          const name = rest || `teammate-${team.members.length + 1}`;
          const id = randomUUID().slice(0, 8);
          await team.spawnTeammate({ id, name, logger, engineOptions: { disableBuiltInPlugins: true } });
          console.log(`${c.green}✓${c.reset} Spawned: ${name} (${id})`);
          break;
        }

        case 'plan': {
          if (!rest) { console.log('Usage: plan <task description>'); break; }
          const { planTeam } = await import('pulse-coder-agent-teams');
          console.log(`${c.dim}Planning...${c.reset}`);
          const plan = await planTeam(rest, { logger });
          printPlan(plan);
          break;
        }

        case 'orchestrate': {
          if (!lead) { console.log('Create a team first: create <name>'); break; }
          if (!rest) { console.log('Usage: orchestrate <task description>'); break; }
          loggerQuiet = true;
          const { synthesis } = await lead.orchestrate(rest, {
            onPlan: async (plan) => { printPlan(plan); return true; },
          });
          loggerQuiet = false;
          console.log(`\n${c.bold}Synthesis${c.reset}`);
          console.log(synthesis);
          break;
        }

        case 'task': {
          if (!team) { console.log('Create a team first.'); break; }
          await team.createTasks([{ title: rest, description: rest }]);
          console.log(`${c.green}✓${c.reset} Task created: ${rest}`);
          break;
        }

        case 'run': {
          if (!team) { console.log('Create a team first.'); break; }
          loggerQuiet = true;
          const { stats } = await team.run();
          loggerQuiet = false;
          console.log(`${c.green}✓${c.reset} Done. ${stats.completed}/${stats.total} completed, ${stats.failed} failed.`);
          break;
        }

        case 'status': {
          if (!team) { console.log('No active team.'); break; }
          console.log(`\n  ${c.bold}${team.name}${c.reset} ${c.dim}(${team.status})${c.reset}`);
          for (const m of team.members) {
            const icon = m.status === 'running' ? `${c.cyan}▶${c.reset}` : m.status === 'idle' ? `${c.yellow}○${c.reset}` : `${c.dim}·${c.reset}`;
            console.log(`  ${icon}  ${m.name} ${c.dim}(${m.id})${c.reset}`);
          }
          const stats = team.getTaskList().stats();
          console.log(`\n  ${c.dim}Tasks:${c.reset} ${stats.total} total, ${c.green}${stats.completed} done${c.reset}, ${stats.in_progress} active, ${stats.pending} pending\n`);
          break;
        }

        case 'tasks': {
          if (!team) { console.log('No active team.'); break; }
          const tasks = team.getTaskList().getAll();
          if (tasks.length === 0) { console.log('No tasks.'); break; }
          console.log('');
          for (const t of tasks) {
            const icon = t.status === 'completed' ? `${c.green}✓${c.reset}` :
                         t.status === 'in_progress' ? `${c.cyan}▶${c.reset}` :
                         t.status === 'failed' ? `${c.red}✗${c.reset}` : `${c.dim}○${c.reset}`;
            const deps = t.deps.length > 0 ? ` ${c.dim}(deps: ${t.deps.map(d => d.slice(0, 8)).join(', ')})${c.reset}` : '';
            console.log(`  ${icon}  ${t.title} ${c.dim}→ ${t.assignee || 'unassigned'}${c.reset}${deps}`);
          }
          console.log('');
          break;
        }

        case 'message': {
          if (!lead) { console.log('No active team.'); break; }
          const [toId, ...msgParts] = rest.split(' ');
          lead.sendMessage(toId, msgParts.join(' '));
          console.log(`${c.green}✓${c.reset} Sent to ${toId}.`);
          break;
        }

        case 'broadcast': {
          if (!lead) { console.log('No active team.'); break; }
          lead.broadcast(rest);
          console.log(`${c.green}✓${c.reset} Broadcast sent.`);
          break;
        }

        case 'inbox': {
          if (!lead) { console.log('No active team.'); break; }
          const msgs = lead.readMessages();
          if (msgs.length === 0) { console.log(`${c.dim}No unread messages.${c.reset}`); break; }
          console.log('');
          for (const m of msgs) {
            console.log(`  ${c.blue}${m.from}${c.reset} ${c.dim}(${m.type})${c.reset}: ${m.content}`);
          }
          console.log('');
          break;
        }

        case 'approve': {
          if (!lead) { console.log('No active team.'); break; }
          const [mateId] = rest.split(' ');
          if (!mateId) { console.log('Usage: approve <teammate-id>'); break; }
          lead.approvePlan(mateId);
          console.log(`${c.green}✓${c.reset} Plan approved for ${mateId}.`);
          break;
        }

        case 'reject': {
          if (!lead) { console.log('No active team.'); break; }
          const [rejId, ...feedbackParts] = rest.split(' ');
          if (!rejId) { console.log('Usage: reject <teammate-id> <feedback>'); break; }
          lead.rejectPlan(rejId, feedbackParts.join(' ') || 'Please revise.');
          console.log(`${c.yellow}✗${c.reset} Plan rejected for ${rejId}.`);
          break;
        }

        case 'cleanup': {
          if (!team) { console.log('No active team.'); break; }
          await team.cleanup();
          display?.stop();
          team = null;
          lead = null;
          display = null;
          console.log(`${c.green}✓${c.reset} Team cleaned up.`);
          break;
        }

        case 'help':
          printInteractiveHelp();
          break;

        case 'exit':
        case 'quit':
          if (team) {
            try { await team.cleanup(); } catch { /* best effort */ }
          }
          display?.stop();
          rl.close();
          return;

        default:
          if (cmd) console.log(`Unknown: ${cmd}. Type "help" for commands.`);
          break;
      }
    } catch (err: any) {
      console.error(`${c.red}Error:${c.reset} ${err.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// ─── Display helpers ──────────────────────────────────────────────

function printBanner(task: string, concurrency?: number): void {
  console.log('');
  console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  const concLabel = concurrency ? `${c.dim}  concurrency: ${concurrency}${c.reset}` : '';
  console.log(`${c.bold}  Pulse Agent Teams${c.reset}${concLabel}`);
  console.log(`${c.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.dim}  ${task}${c.reset}`);
  console.log('');
}

function printPhase(num: number, label: string): void {
  console.log(`  ${c.bold}${c.cyan}[${num}]${c.reset} ${c.bold}${label}${c.reset}`);
  console.log('');
}

function printPlan(plan: TeamPlan): void {
  // Teammates
  console.log(`  ${c.dim}┌─ Teammates (${plan.teammates.length}) ──────────────────────────────────────┐${c.reset}`);
  for (let i = 0; i < plan.teammates.length; i++) {
    const t = plan.teammates[i];
    const isLast = i === plan.teammates.length - 1;
    const branch = isLast ? '└' : '├';
    const truncRole = t.role.length > 50 ? t.role.slice(0, 50) + '...' : t.role;
    console.log(`  ${c.dim}│${c.reset}  ${c.dim}${branch}──${c.reset} ${c.bold}${c.blue}${t.name}${c.reset}  ${c.dim}${truncRole}${c.reset}`);
  }
  console.log(`  ${c.dim}│${c.reset}`);

  // Tasks
  console.log(`  ${c.dim}├─ Tasks (${plan.tasks.length}) ─────────────────────────────────────────┐${c.reset}`);
  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i];
    const isLast = i === plan.tasks.length - 1;
    const branch = isLast ? '└' : '├';

    const assign = t.assignTo ? `${c.blue}${t.assignTo}${c.reset}` : `${c.dim}unassigned${c.reset}`;
    const deps = t.depNames?.length ? ` ${c.yellow}← ${t.depNames.join(', ')}${c.reset}` : '';

    console.log(`  ${c.dim}│${c.reset}  ${c.dim}${branch}──${c.reset} ${t.title} ${c.dim}→${c.reset} ${assign}${deps}`);
  }
  console.log(`  ${c.dim}└──────────────────────────────────────────────────────┘${c.reset}`);
  console.log('');
}

function printUsage(): void {
  console.log(`
${c.bold}Pulse Agent Teams CLI${c.reset}

${c.dim}Usage:${c.reset}
  pulse-teams run "<task>"       Run with LLM-driven planning & execution
  pulse-teams plan "<task>"      Plan only (preview, don't execute)
  pulse-teams interactive        Interactive team management REPL
  pulse-teams "<task>"           Shorthand for 'run'
  pulse-teams --help             Show this help

${c.dim}Options:${c.reset}
  --concurrency N                Max teammates running in parallel (default: all)
  --verbose, -v                  Show LLM output from teammates

${c.dim}Examples:${c.reset}
  pulse-teams run "Review this codebase for security issues"
  pulse-teams run "Audit the codebase" --concurrency 2
  pulse-teams plan "Refactor the auth module for testability"
`);
}

function printInteractiveHelp(): void {
  console.log(`
${c.bold}Team${c.reset}                            ${c.bold}Tasks${c.reset}
  create [name]                   task <description>
  spawn [name]                    tasks
  status                          run
  cleanup                         plan <description>
                                  orchestrate <description>
${c.bold}Communication${c.reset}                    ${c.bold}Plan Approval${c.reset}
  message <id> <text>             approve <teammate-id>
  broadcast <text>                reject <id> <feedback>
  inbox

${c.dim}exit / quit / help${c.reset}
`);
}

// ─── Entry ─────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
