export interface TuiHelpItem {
  command: string;
  description: string;
}

interface OutputLike {
  isTTY?: boolean;
  columns?: number;
  write(chunk: string): boolean;
  clearLine?(dir: number): boolean;
  cursorTo?(x: number): boolean;
}

interface TuiRendererOptions {
  output?: OutputLike;
  enabled?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const CYAN = '\u001b[36m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const MAGENTA = '\u001b[35m';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class TuiRenderer {
  private readonly output: OutputLike;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerIndex = 0;
  private spinnerLabel = 'Processing';
  private spinnerStartedAt = 0;
  private statusLineActive = false;

  constructor(options: TuiRendererOptions = {}) {
    this.output = options.output ?? process.stdout;
    const env = options.env ?? process.env;
    this.enabled = options.enabled ?? this.detectEnabled(env);
    this.now = options.now ?? (() => Date.now());
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  prompt(mode: 'default' | 'teams' = 'default'): string {
    if (!this.enabled) {
      return mode === 'teams' ? 'teams> ' : '> ';
    }

    const label = mode === 'teams' ? `${MAGENTA}teams›${RESET}` : `${CYAN}›${RESET}`;
    return `${label} `;
  }

  showWelcome(): void {
    if (!this.enabled) {
      this.writeLine('🚀 Pulse Coder CLI is running...');
      this.writeLine('Type your messages and press Enter. Type "exit" to quit.');
      this.writeLine('Press Esc to stop current response and continue with new input.');
      this.writeLine('Press Ctrl+C to exit CLI.');
      this.writeLine('Commands starting with "/" will trigger command mode.\n');
      return;
    }

    this.writeLine(this.box('Pulse Coder CLI', [
      'Type a message and press Enter to run the agent.',
      'Use /help for commands, /status for session details.',
      'Esc stops the current response; Ctrl+C exits safely.',
    ]));
  }

  showHelp(items: TuiHelpItem[], footer: string[] = []): void {
    if (!this.enabled) {
      this.writeLine('\n📋 Available commands:');
      for (const item of items) {
        this.writeLine(`${item.command} - ${item.description}`);
      }
      for (const line of footer) {
        this.writeLine(line);
      }
      return;
    }

    const commandWidth = Math.max(...items.map(item => item.command.length));
    const lines = items.map(item => `${this.color(item.command.padEnd(commandWidth), CYAN)}  ${item.description}`);
    if (footer.length > 0) {
      lines.push('', ...footer.map(line => this.color(line, DIM)));
    }
    this.writeLine(`\n${this.box('Commands', lines)}`);
  }

  showPluginStatus(count: number): void {
    this.success(`Built-in plugins loaded: ${count} plugins`);
  }

  section(title: string, lines: string[]): void {
    this.stopProcessing();
    if (!this.enabled) {
      this.writeLine(`\n${title}:`);
      for (const line of lines) {
        this.writeLine(line);
      }
      return;
    }

    this.writeLine(`\n${this.box(title, lines)}`);
  }

  plain(message = ''): void {
    this.stopProcessing();
    this.writeLine(message);
  }

  inline(message = ''): void {
    this.stopProcessing();
    this.write(message);
  }

  startProcessing(label = 'Processing'): void {
    if (!this.enabled) {
      this.writeLine('\n🔄 Processing...\n');
      return;
    }

    this.stopProcessing();
    this.spinnerLabel = label;
    this.spinnerStartedAt = this.now();
    this.spinnerIndex = 0;
    this.write('\n');
    this.renderSpinner();
    this.spinnerTimer = setInterval(() => this.renderSpinner(), 120);
  }

  stopProcessing(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }

    if (this.statusLineActive) {
      this.clearLine();
      this.statusLineActive = false;
    }
  }

  text(delta: string): void {
    this.stopProcessing();
    this.write(delta);
  }

  toolCall(name: string, input?: unknown): void {
    this.stopProcessing();
    const inputText = input === undefined ? '' : ` ${this.color(this.truncate(this.safeJson(input), 180), DIM)}`;
    this.writeLine(`\n${this.color('🔧', CYAN)} ${this.color(name, BOLD)}${inputText}`);
  }

  toolResult(name: string): void {
    this.stopProcessing();
    this.writeLine(`\n${this.color('✅', GREEN)} ${name}`);
  }

  stepFinished(reason: string): void {
    this.stopProcessing();
    this.writeLine(`\n${this.color('📋', MAGENTA)} Step finished: ${reason}`);
  }

  info(message: string): void {
    this.stopProcessing();
    this.writeLine(`${this.color('ℹ', CYAN)} ${message}`);
  }

  success(message: string): void {
    this.stopProcessing();
    this.writeLine(`${this.color('✅', GREEN)} ${message}`);
  }

  warn(message: string): void {
    this.stopProcessing();
    this.writeLine(`${this.color('⚠', YELLOW)} ${message}`);
  }

  error(message: string): void {
    this.stopProcessing();
    this.writeLine(`${this.color('❌', RED)} ${message}`);
  }

  abort(message: string): void {
    this.stopProcessing();
    this.writeLine(`\n${this.color('[Abort]', YELLOW)} ${message}`);
  }

  queued(message: string): void {
    this.stopProcessing();
    this.writeLine(`\n${this.color('📝', CYAN)} ${message}`);
  }

  private detectEnabled(env: NodeJS.ProcessEnv): boolean {
    if (!this.output.isTTY) {
      return false;
    }
    if (env.PULSE_CODER_PLAIN === '1' || env.NO_COLOR || env.TERM === 'dumb') {
      return false;
    }
    return true;
  }

  private box(title: string, lines: string[]): string {
    const visibleLines = lines.map(line => this.stripAnsi(line));
    const maxLineLength = Math.max(title.length + 2, ...visibleLines.map(line => line.length));
    const maxWidth = Math.max(42, Math.min(this.output.columns ?? 80, 96) - 4);
    const width = Math.min(Math.max(maxLineLength, 42), maxWidth);
    const top = `╭─ ${this.color(title, BOLD)} ${'─'.repeat(Math.max(0, width - title.length - 3))}╮`;
    const bottom = `╰${'─'.repeat(width + 2)}╯`;
    const body = lines.flatMap(line => this.wrapVisible(line, width)).map(line => {
      const padding = width - this.stripAnsi(line).length;
      return `│ ${line}${' '.repeat(Math.max(0, padding))} │`;
    });

    return [top, ...body, bottom].join('\n');
  }

  private renderSpinner(): void {
    const frame = SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length];
    this.spinnerIndex += 1;
    const elapsed = Math.max(0, Math.floor((this.now() - this.spinnerStartedAt) / 1000));
    const line = `${this.color(frame, CYAN)} ${this.spinnerLabel} ${this.color(`${elapsed}s`, DIM)} ${this.color('Esc to stop', DIM)}`;
    this.clearLine();
    this.write(line);
    this.statusLineActive = true;
  }

  private clearLine(): void {
    if (!this.enabled) {
      return;
    }

    this.output.clearLine?.(0);
    this.output.cursorTo?.(0);
  }

  private wrapVisible(line: string, width: number): string[] {
    if (this.stripAnsi(line).length <= width) {
      return [line];
    }

    const plain = this.stripAnsi(line);
    const wrapped: string[] = [];
    for (let index = 0; index < plain.length; index += width) {
      wrapped.push(plain.slice(index, index + width));
    }
    return wrapped;
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 1)}…`;
  }

  private color(value: string, code: string): string {
    return this.enabled ? `${code}${value}${RESET}` : value;
  }

  private stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
  }

  private writeLine(line: string): void {
    this.write(`${line}\n`);
  }

  private write(chunk: string): void {
    this.output.write(chunk);
  }
}
