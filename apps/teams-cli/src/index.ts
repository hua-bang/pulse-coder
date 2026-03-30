import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Team, TeamLead } from 'pulse-coder-agent-teams';
import type { TeamConfig, TeammateOptions, CreateTaskInput, TeamPlan } from 'pulse-coder-agent-teams';
import { InProcessDisplay } from './display/in-process.js';

// ─── Logger ────────────────────────────────────────────────────────

const logger = {
  debug(msg: string) { /* silent by default */ },
  info(msg: string) { console.log(`[info] ${msg}`); },
  warn(msg: string) { console.warn(`[warn] ${msg}`); },
  error(msg: string, err?: Error) { console.error(`[error] ${msg}`, err?.message || ''); },
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

/**
 * Run a team with TeamLead orchestrating.
 * Flow: LLM plans → confirm → spawn → execute → synthesize
 */
async function runTeam(args: string[]) {
  const taskDescription = args.join(' ');
  if (!taskDescription) {
    console.error('Error: Please provide a task description.');
    console.error('Usage: pulse-teams run "Your task description"');
    process.exit(1);
  }

  const teamName = `team-${Date.now()}`;
  const lead = new TeamLead({
    teamName,
    logger,
    defaultTeammateEngineOptions: { disableBuiltInPlugins: true },
  });

  const display = new InProcessDisplay(lead.team);
  display.start();

  try {
    await lead.initialize();

    const { plan, synthesis } = await lead.orchestrate(taskDescription, {
      onPlan: async (plan) => {
        printPlan(plan);
        // Auto-approve in non-interactive mode
        return true;
      },
    });

    console.log('\n' + '='.repeat(60));
    console.log('  Synthesis');
    console.log('='.repeat(60));
    console.log(synthesis);

    await lead.team.shutdownAll();
    await lead.team.cleanup();
  } catch (err: any) {
    console.error(`\nTeam run failed: ${err.message}`);
    try { await lead.team.shutdownAll(); await lead.team.cleanup(); } catch { /* best effort */ }
    process.exit(1);
  } finally {
    display.stop();
  }
}

// ─── Plan-only mode ────────────────────────────────────────────────

/**
 * Just plan, don't execute. Show the plan for review.
 */
async function planOnly(args: string[]) {
  const taskDescription = args.join(' ');
  if (!taskDescription) {
    console.error('Error: Please provide a task description.');
    process.exit(1);
  }

  const { planTeam } = await import('pulse-coder-agent-teams');

  console.log('Planning team structure...\n');
  const plan = await planTeam(taskDescription, { logger });
  printPlan(plan);
}

// ─── Interactive mode ──────────────────────────────────────────────

/**
 * Interactive REPL with TeamLead support.
 */
async function interactiveMode() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'teams> ',
  });

  let team: Team | null = null;
  let lead: TeamLead | null = null;
  let display: InProcessDisplay | null = null;

  console.log('Pulse Agent Teams — Interactive Mode');
  console.log('Type "help" for available commands.\n');

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
          console.log(`Team "${name}" created with TeamLead.`);
          break;
        }

        case 'spawn': {
          if (!team) { console.log('Create a team first: create <name>'); break; }
          const name = rest || `teammate-${team.members.length + 1}`;
          const id = randomUUID().slice(0, 8);
          await team.spawnTeammate({ id, name, logger, engineOptions: { disableBuiltInPlugins: true } });
          console.log(`Spawned teammate: ${name} (${id})`);
          break;
        }

        case 'plan': {
          if (!rest) { console.log('Usage: plan <task description>'); break; }
          const { planTeam } = await import('pulse-coder-agent-teams');
          console.log('Planning...');
          const plan = await planTeam(rest, { logger });
          printPlan(plan);
          break;
        }

        case 'orchestrate': {
          if (!lead) { console.log('Create a team first: create <name>'); break; }
          if (!rest) { console.log('Usage: orchestrate <task description>'); break; }
          console.log('Orchestrating...');
          const { synthesis } = await lead.orchestrate(rest, {
            onPlan: async (plan) => {
              printPlan(plan);
              return true;
            },
          });
          console.log('\n--- Synthesis ---');
          console.log(synthesis);
          break;
        }

        case 'task': {
          if (!team) { console.log('Create a team first.'); break; }
          await team.createTasks([{ title: rest, description: rest }]);
          console.log(`Task created: ${rest}`);
          break;
        }

        case 'run': {
          if (!team) { console.log('Create a team first.'); break; }
          console.log('Running team...');
          const { stats } = await team.run();
          console.log(`Done. ${stats.completed}/${stats.total} completed, ${stats.failed} failed.`);
          break;
        }

        case 'status': {
          if (!team) { console.log('No active team.'); break; }
          console.log(`Team: ${team.name} (${team.status})`);
          console.log(`Members: ${team.members.length}`);
          for (const m of team.members) {
            console.log(`  - ${m.name} (${m.id}) [${m.status}]`);
          }
          const stats = team.getTaskList().stats();
          console.log(`Tasks: ${stats.total} total, ${stats.completed} done, ${stats.in_progress} active, ${stats.pending} pending`);
          break;
        }

        case 'tasks': {
          if (!team) { console.log('No active team.'); break; }
          const tasks = team.getTaskList().getAll();
          if (tasks.length === 0) { console.log('No tasks.'); break; }
          for (const t of tasks) {
            const deps = t.deps.length > 0 ? ` (deps: ${t.deps.map(d => d.slice(0, 8)).join(', ')})` : '';
            console.log(`  [${t.status}] ${t.title} (${t.id.slice(0, 8)}) -> ${t.assignee || 'unassigned'}${deps}`);
          }
          break;
        }

        case 'message': {
          if (!lead) { console.log('No active team.'); break; }
          const [toId, ...msgParts] = rest.split(' ');
          lead.sendMessage(toId, msgParts.join(' '));
          console.log(`Message sent to ${toId}.`);
          break;
        }

        case 'broadcast': {
          if (!lead) { console.log('No active team.'); break; }
          lead.broadcast(rest);
          console.log('Broadcast sent.');
          break;
        }

        case 'inbox': {
          if (!lead) { console.log('No active team.'); break; }
          const msgs = lead.readMessages();
          if (msgs.length === 0) { console.log('No unread messages.'); break; }
          for (const m of msgs) {
            console.log(`  [from: ${m.from}] (${m.type}) ${m.content}`);
          }
          break;
        }

        case 'approve': {
          if (!lead) { console.log('No active team.'); break; }
          const [mateId] = rest.split(' ');
          if (!mateId) { console.log('Usage: approve <teammate-id>'); break; }
          lead.approvePlan(mateId);
          console.log(`Plan approved for ${mateId}.`);
          break;
        }

        case 'reject': {
          if (!lead) { console.log('No active team.'); break; }
          const [rejId, ...feedbackParts] = rest.split(' ');
          if (!rejId) { console.log('Usage: reject <teammate-id> <feedback>'); break; }
          lead.rejectPlan(rejId, feedbackParts.join(' ') || 'Please revise.');
          console.log(`Plan rejected for ${rejId}.`);
          break;
        }

        case 'cleanup': {
          if (!team) { console.log('No active team.'); break; }
          await team.shutdownAll();
          await team.cleanup();
          display?.stop();
          team = null;
          lead = null;
          display = null;
          console.log('Team cleaned up.');
          break;
        }

        case 'help':
          printInteractiveHelp();
          break;

        case 'exit':
        case 'quit':
          if (team) {
            try { await team.shutdownAll(); await team.cleanup(); } catch { /* best effort */ }
          }
          display?.stop();
          rl.close();
          return;

        default:
          if (cmd) console.log(`Unknown command: ${cmd}. Type "help" for available commands.`);
          break;
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// ─── Helpers ───────────────────────────────────────────────────────

function printPlan(plan: TeamPlan): void {
  console.log('\n--- Team Plan ---');
  console.log(`\nTeammates (${plan.teammates.length}):`);
  for (const t of plan.teammates) {
    console.log(`  - ${t.name}: ${t.role}${t.model ? ` [model: ${t.model}]` : ''}`);
  }
  console.log(`\nTasks (${plan.tasks.length}):`);
  for (const t of plan.tasks) {
    const deps = t.depNames?.length ? ` (after: ${t.depNames.join(', ')})` : '';
    const assign = t.assignTo ? ` -> ${t.assignTo}` : '';
    console.log(`  - ${t.title}${assign}${deps}`);
    console.log(`    ${t.description.slice(0, 100)}${t.description.length > 100 ? '...' : ''}`);
  }
  console.log('');
}

function printUsage(): void {
  console.log(`
Pulse Agent Teams CLI

Usage:
  pulse-teams run "<task>"       Run a team with LLM-driven planning & execution
  pulse-teams plan "<task>"      Plan only (show team structure, don't execute)
  pulse-teams interactive        Start interactive team management REPL
  pulse-teams "<task>"           Shorthand for 'run'
  pulse-teams --help             Show this help

Examples:
  pulse-teams run "Review PR #142 from security, performance, and test angles"
  pulse-teams plan "Refactor the auth module for better testability"
  pulse-teams "Investigate the login timeout bug from different angles"
  pulse-teams interactive
`);
}

function printInteractiveHelp(): void {
  console.log(`
Team Management:
  create [name]                Create a new team with TeamLead
  spawn [name]                 Spawn a teammate
  cleanup                      Clean up the team

Planning & Execution:
  plan <description>           Generate a plan (preview only)
  orchestrate <description>    Full flow: plan -> spawn -> execute -> synthesize
  task <description>           Create a manual task
  run                          Run the team (execute all tasks)

Communication:
  message <id> <text>          Send a message to a teammate
  broadcast <text>             Broadcast to all teammates
  inbox                        Read messages sent to the lead

Plan Approval:
  approve <teammate-id>        Approve a teammate's plan
  reject <id> <feedback>       Reject with feedback

Status:
  status                       Show team status
  tasks                        List all tasks

General:
  help                         Show this help
  exit                         Exit
`);
}

// ─── Entry ─────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
