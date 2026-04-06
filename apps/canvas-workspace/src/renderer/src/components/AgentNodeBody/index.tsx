import { useCallback, useRef, useState } from 'react';
import './index.css';
import type { CanvasNode, AgentNodeData } from '../../types';

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

const STATUS_LABELS: Record<AgentNodeData['status'], string> = {
  idle: 'Idle',
  running: 'Running...',
  done: 'Done',
  error: 'Error',
};

export const AgentNodeBody = ({ node, onUpdate }: Props) => {
  const data = node.data as AgentNodeData;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [localPrompt, setLocalPrompt] = useState(data.prompt);

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setLocalPrompt(e.target.value);
    },
    []
  );

  const handlePromptBlur = useCallback(() => {
    if (localPrompt !== data.prompt) {
      onUpdate(node.id, { data: { ...data, prompt: localPrompt } });
    }
  }, [localPrompt, data, node.id, onUpdate]);

  const handleRun = useCallback(() => {
    if (data.status === 'running') return;
    onUpdate(node.id, {
      data: { ...data, prompt: localPrompt, status: 'running', output: '', error: undefined },
    });
  }, [data, localPrompt, node.id, onUpdate]);

  const handleStop = useCallback(() => {
    if (data.status !== 'running') return;
    onUpdate(node.id, {
      data: { ...data, status: 'idle' },
    });
  }, [data, node.id, onUpdate]);

  const handleClear = useCallback(() => {
    onUpdate(node.id, {
      data: { ...data, output: '', error: undefined, status: 'idle' },
    });
  }, [data, node.id, onUpdate]);

  return (
    <div className="agent-body">
      <div className="agent-prompt-section">
        <textarea
          ref={textareaRef}
          className="agent-prompt-input"
          placeholder="Enter prompt for the agent..."
          value={localPrompt}
          onChange={handlePromptChange}
          onBlur={handlePromptBlur}
          onMouseDown={(e) => e.stopPropagation()}
        />
      </div>
      <div className="agent-controls">
        <div className={`agent-status agent-status--${data.status}`}>
          <span className="agent-status-dot" />
          <span className="agent-status-label">{STATUS_LABELS[data.status]}</span>
        </div>
        <div className="agent-actions">
          {data.status === 'running' ? (
            <button className="agent-btn agent-btn--stop" onClick={handleStop}>
              Stop
            </button>
          ) : (
            <button
              className="agent-btn agent-btn--run"
              onClick={handleRun}
              disabled={!localPrompt.trim()}
            >
              Run
            </button>
          )}
          {(data.output || data.error) && data.status !== 'running' && (
            <button className="agent-btn agent-btn--clear" onClick={handleClear}>
              Clear
            </button>
          )}
        </div>
      </div>
      {(data.output || data.error) && (
        <div className="agent-output-section">
          {data.error ? (
            <pre className="agent-output agent-output--error">{data.error}</pre>
          ) : (
            <pre className="agent-output">{data.output}</pre>
          )}
        </div>
      )}
    </div>
  );
};
