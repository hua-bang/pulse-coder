import type { Tool } from '../../shared/types';

export type ToolSearchVariant = 'regex' | 'bm25';

export interface ToolSearchResult {
  toolName: string;
  score: number;
  reason?: string;
}

const DEFAULT_CANDIDATES = 20;
const DEFAULT_LIMIT = 10;
const DEFAULT_WEIGHTS = {
  name: 3,
  description: 2,
  argName: 2,
  argDescription: 1,
};

type SearchableField = {
  text: string;
  weight: number;
};

function extractToolFields(tool: Tool, registeredName?: string): SearchableField[] {
  const fields: SearchableField[] = [];
  const weights = DEFAULT_WEIGHTS;

  const effectiveName = tool.name || registeredName;
  if (effectiveName) {
    fields.push({ text: effectiveName, weight: weights.name });
  }
  if (tool.description) {
    fields.push({ text: tool.description, weight: weights.description });
  }

  const schema: any = tool.inputSchema as any;
  const shape = schema?.shape ?? schema?._def?.shape ?? schema?._def?.schema?.shape;
  const resolvedShape = typeof shape === 'function' ? shape() : shape;

  if (resolvedShape && typeof resolvedShape === 'object') {
    for (const [argName, argSchema] of Object.entries(resolvedShape)) {
      fields.push({ text: String(argName), weight: weights.argName });
      const description = (argSchema as any)?._def?.description;
      if (description) {
        fields.push({ text: String(description), weight: weights.argDescription });
      }
    }
  }

  return fields.filter((field) => field.text && field.text.trim().length > 0);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_\-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function termFrequency(term: string, docTokens: string[]): number {
  let count = 0;
  for (const token of docTokens) {
    if (token === term) {
      count += 1;
    }
  }
  return count;
}

export function searchToolsRegex(
  tools: Record<string, Tool>,
  query: string,
  options?: { limit?: number }
): ToolSearchResult[] {
  if (!query) {
    return [];
  }

  let regex: RegExp;
  try {
    regex = new RegExp(query);
  } catch (error) {
    throw new Error(`Invalid regex query: ${error instanceof Error ? error.message : String(error)}`);
  }

  const results: ToolSearchResult[] = [];
  for (const [registeredName, tool] of Object.entries(tools)) {
    const fields = extractToolFields(tool, registeredName);
    let score = 0;
    for (const field of fields) {
      if (regex.test(field.text)) {
        score += field.weight;
      }
    }
    if (score > 0) {
      results.push({ toolName: registeredName, score });
    }
  }

  results.sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName));
  return results.slice(0, options?.limit ?? DEFAULT_LIMIT);
}

export function searchToolsBm25(
  tools: Record<string, Tool>,
  query: string,
  options?: { limit?: number; candidates?: number }
): ToolSearchResult[] {
  if (!query.trim()) {
    return [];
  }

  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  const docs = Object.entries(tools).map(([toolName, tool]) => {
    const fields = extractToolFields(tool, toolName);
    const docText = fields.map((field) => field.text).join(' ');
    const docTokens = tokenize(docText);
    return {
      tool,
      toolName,
      fields,
      docTokens,
      length: docTokens.length || 1,
    };
  });

  const avgDocLength = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);
  const totalDocs = docs.length || 1;

  const docFrequency = new Map<string, number>();
  for (const token of tokens) {
    let count = 0;
    for (const doc of docs) {
      if (doc.docTokens.includes(token)) {
        count += 1;
      }
    }
    docFrequency.set(token, count);
  }

  const k1 = 1.2;
  const b = 0.75;

  const results: ToolSearchResult[] = [];
  for (const doc of docs) {
    let score = 0;
    for (const term of tokens) {
      const df = docFrequency.get(term) || 0;
      if (df === 0) {
        continue;
      }
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      const tf = termFrequency(term, doc.docTokens);
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (doc.length / avgDocLength));
      score += idf * (numerator / denominator);
    }

    if (score > 0) {
      results.push({ toolName: doc.toolName, score });
    }
  }

  results.sort((a, b) => b.score - a.score || a.toolName.localeCompare(b.toolName));
  const candidateLimit = options?.candidates ?? DEFAULT_CANDIDATES;
  return results.slice(0, candidateLimit).slice(0, options?.limit ?? DEFAULT_LIMIT);
}

export function buildToolSearchReferenceResult(
  matches: ToolSearchResult[],
  options?: { limit?: number }
): { type: 'tool_search_tool_search_result'; tool_references: Array<{ type: 'tool_reference'; tool_name: string }> } {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const tool_references = matches.slice(0, limit).map((match) => ({
    type: 'tool_reference',
    tool_name: match.toolName,
  }));

  return { type: 'tool_search_tool_search_result', tool_references };
}

export function filterDeferredTools(tools: Record<string, Tool>): Record<string, Tool> {
  const deferred: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.defer_loading || tool.deferLoading) {
      deferred[name] = tool;
    }
  }
  return deferred;
}

export function filterImmediateTools(tools: Record<string, Tool>): Record<string, Tool> {
  const immediate: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (tool.defer_loading || tool.deferLoading) {
      continue;
    }
    immediate[name] = tool;
  }
  return immediate;
}

export function getSearchableToolCatalog(tools: Record<string, Tool>): Record<string, Tool> {
  return filterDeferredTools(tools);
}

export function buildToolSearchSummary(tools: Record<string, Tool>, limit: number = 40): string {
  const deferred = filterDeferredTools(tools);
  const names = Object.keys(deferred).sort();
  const shown = names.slice(0, Math.max(0, limit));
  const omitted = names.length - shown.length;

  const lines = [
    `Tool search catalog: ${names.length} deferred tool(s).`,
  ];

  if (shown.length > 0) {
    lines.push(`Deferred tools preview: ${shown.join(', ')}`);
  }

  if (omitted > 0) {
    lines.push(`... ${omitted} additional deferred tool(s) omitted for brevity.`);
  }

  return lines.join('\n');
}
