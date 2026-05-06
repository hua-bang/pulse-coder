import React, { useEffect, useMemo, useState } from 'react';

export type InkEventKind = 'user' | 'assistant' | 'tool' | 'result' | 'system' | 'error';

interface InkRuntime {
  Box: React.ComponentType<any>;
  Text: React.ComponentType<any>;
  useApp: () => { exit: () => void };
  useInput: (handler: (input: string, key: any) => void) => void;
  useStdout: () => { stdout: { rows?: number } };
}

export interface InkCliEvent {
  id: string;
  kind: InkEventKind;
  title?: string;
  text: string;
}

export interface InkCliSnapshot {
  sessionId?: string | null;
  taskListId?: string | null;
  mode?: string | null;
  messages: number;
  estimatedTokens: number;
  isProcessing: boolean;
  status: string;
  events: InkCliEvent[];
}

export interface InkCliController {
  getSnapshot: () => InkCliSnapshot;
  submitInput: (input: string) => void | Promise<void>;
  requestStop: () => void;
  shutdown: () => void | Promise<void>;
  subscribe: (listener: (snapshot: InkCliSnapshot) => void) => () => void;
}

interface InkCliAppProps {
  controller: InkCliController;
  runtime: InkRuntime;
  onExit?: () => void;
}

const DEFAULT_SNAPSHOT: InkCliSnapshot = {
  sessionId: null,
  taskListId: null,
  mode: null,
  messages: 0,
  estimatedTokens: 0,
  isProcessing: false,
  status: 'Ready',
  events: [],
};

const KIND_LABEL: Record<InkEventKind, string> = {
  user: 'You',
  assistant: 'Assistant',
  tool: 'Tool',
  result: 'Result',
  system: 'System',
  error: 'Error',
};

const KIND_COLOR: Record<InkEventKind, string> = {
  user: 'cyan',
  assistant: 'green',
  tool: 'magenta',
  result: 'green',
  system: 'blue',
  error: 'red',
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function InkCliApp({ controller, runtime, onExit }: InkCliAppProps) {
  const { Box, Text, useApp, useInput, useStdout } = runtime;
  const [snapshot, setSnapshot] = useState<InkCliSnapshot>(() => ({
    ...DEFAULT_SNAPSHOT,
    ...controller.getSnapshot(),
  }));
  const [input, setInput] = useState('');
  const [cursorVisible, setCursorVisible] = useState(true);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  const app = useApp();
  const { stdout } = useStdout();

  useEffect(() => controller.subscribe(setSnapshot), [controller]);

  useEffect(() => {
    const timer = setInterval(() => setCursorVisible(current => !current), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!snapshot.isProcessing) {
      return;
    }

    const timer = setInterval(() => setSpinnerIndex(current => current + 1), 120);
    return () => clearInterval(timer);
  }, [snapshot.isProcessing]);

  useInput((value, key) => {
    if (key.ctrl && value === 'c') {
      void controller.shutdown();
      onExit?.();
      app.exit();
      return;
    }

    if (key.escape) {
      if (snapshot.isProcessing) {
        controller.requestStop();
        return;
      }

      void controller.shutdown();
      onExit?.();
      app.exit();
      return;
    }

    if (key.return) {
      const submitted = input;
      setInput('');
      void (async () => {
        await controller.submitInput(submitted);
        const normalized = submitted.trim().toLowerCase();
        if (normalized === 'exit' || normalized === '/exit') {
          onExit?.();
          app.exit();
        }
      })();
      return;
    }

    if (key.backspace || key.delete) {
      setInput(current => current.slice(0, -1));
      return;
    }

    if (key.ctrl && value === 'u') {
      setInput('');
      return;
    }

    if (value && !key.ctrl && !key.meta) {
      setInput(current => `${current}${value}`);
    }
  });

  const terminalRows = stdout.rows ?? 30;
  const visibleEventCount = Math.max(4, Math.min(12, terminalRows - 8));
  const visibleEvents = snapshot.events.slice(-visibleEventCount);
  const spinner = snapshot.isProcessing ? SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length] : '●';
  const prompt = useMemo(() => {
    const cursor = cursorVisible ? '█' : ' ';
    return `${input}${cursor}`;
  }, [cursorVisible, input]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">Pulse Coder Ink</Text>
        <Text color="gray">
          session {snapshot.sessionId ?? 'new'} · {snapshot.messages} msgs · ~{snapshot.estimatedTokens} tokens
          {snapshot.taskListId ? ` · tasks ${snapshot.taskListId}` : ''}
          {snapshot.mode ? ` · mode ${snapshot.mode}` : ''}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {visibleEvents.length === 0 ? (
          <Text color="gray">Type a message below. Use /help for commands.</Text>
        ) : visibleEvents.map(event => (
          <Box key={event.id} flexDirection="column" marginBottom={1}>
            <Text bold color={KIND_COLOR[event.kind]}>
              {KIND_LABEL[event.kind]}{event.title ? ` · ${event.title}` : ''}
            </Text>
            <Text>{event.text}</Text>
          </Box>
        ))}
      </Box>

      <Box borderStyle="single" borderColor={snapshot.isProcessing ? 'yellow' : 'green'} paddingX={1} flexDirection="column">
        <Text color={snapshot.isProcessing ? 'yellow' : 'green'}>
          {spinner} {snapshot.status} · Enter send · Esc {snapshot.isProcessing ? 'stop' : 'exit'} · Ctrl+C exit
        </Text>
        <Text color="cyan">› <Text color="white">{prompt}</Text></Text>
      </Box>
    </Box>
  );
}
