import './index.css';
import type { CanvasNode, AgentNodeData } from '../../types';
import { TerminalNodeBody } from '../TerminalNodeBody';

interface Props {
  node: CanvasNode;
  allNodes?: CanvasNode[];
  rootFolder?: string;
  workspaceId?: string;
  workspaceName?: string;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

export const AgentNodeBody = ({ node, allNodes, rootFolder, workspaceId, workspaceName, onUpdate }: Props) => {
  const data = node.data as AgentNodeData;

  return (
    <div className="agent-body-wrap">
      <div className="agent-badge">
        <span className="agent-badge-dot" />
        <span className="agent-badge-label">{data.agentType ?? 'codex'}</span>
      </div>
      <TerminalNodeBody
        node={node}
        allNodes={allNodes}
        rootFolder={rootFolder}
        workspaceId={workspaceId}
        workspaceName={workspaceName}
        onUpdate={onUpdate}
        autoCommand={data.agentCommand}
      />
    </div>
  );
};
