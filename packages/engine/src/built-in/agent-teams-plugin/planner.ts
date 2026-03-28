import { generateTextAI } from '../../ai';
import type { TaskGraph, TeamRole } from './types';

export interface PlannerOptions {
  task: string;
  availableRoles: TeamRole[];
}

const PLANNER_SYSTEM_PROMPT = `你是一个 agent team 规划器。
根据用户描述的任务，输出一个合理的 TaskGraph JSON，决定需要哪些角色、执行顺序和依赖关系。

TaskGraph 格式：
{
  "nodes": [
    {
      "id": "唯一标识符",
      "role": "角色名",
      "deps": ["依赖的节点 id"],
      "input": "该节点的具体任务描述（可选，不填则用原始任务）",
      "instruction": "该节点 agent 的执行指令（可选，用于差异化 prompt）",
      "optional": true/false
    }
  ]
}

规则：
- deps 必须引用已存在的节点 id，不能有环
- 没有依赖关系的节点会并行执行
- optional=true 的节点失败不会阻断后续流程
- 只使用 availableRoles 中列出的角色
- 直接输出 JSON，不要加任何说明文字`;

export async function planTaskGraph(options: PlannerOptions): Promise<TaskGraph> {
  const { task, availableRoles } = options;

  const userPrompt = `任务：${task}

可用角色：${availableRoles.join(', ')}

请输出 TaskGraph JSON：`;

  const result = await generateTextAI(
    [{ role: 'user', content: userPrompt }],
    {},
    { systemPrompt: PLANNER_SYSTEM_PROMPT }
  );

  const raw = result.text?.trim() ?? '';

  // 提取 JSON（兼容 LLM 可能包裹在 ```json ``` 里的情况）
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? null;
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw;

  let graph: TaskGraph;
  try {
    graph = JSON.parse(jsonStr) as TaskGraph;
  } catch {
    throw new Error(`Planner returned invalid JSON: ${jsonStr.slice(0, 200)}`);
  }

  if (!Array.isArray(graph.nodes)) {
    throw new Error('Planner returned invalid TaskGraph: missing nodes array');
  }

  return graph;
}
