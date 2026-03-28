import type { TaskGraph, TeamRole } from './types';

export interface PlannerOptions {
  task: string;
  availableRoles: TeamRole[];
  /** 调用 LLM 的函数，由外部注入，解耦对 engine ai 模块的直接依赖 */
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>;
}

const SYSTEM_PROMPT = `你是一个 agent team 规划器。
根据用户描述的任务，输出一个合理的 TaskGraph JSON，决定需要哪些角色、执行顺序和依赖关系。

TaskGraph 格式：
{
  "nodes": [
    {
      "id": "唯一标识符",
      "role": "角色名",
      "deps": ["依赖的节点 id"],
      "input": "该节点的具体任务描述（可选）",
      "instruction": "该节点 agent 的执行指令（可选，用于差异化 prompt）",
      "optional": true
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
  const { task, availableRoles, llmCall } = options;

  const userPrompt = `任务：${task}\n\n可用角色：${availableRoles.join(', ')}\n\n请输出 TaskGraph JSON：`;
  const raw = (await llmCall(SYSTEM_PROMPT, userPrompt)).trim();

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
