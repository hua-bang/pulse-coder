import type { ExtractedMemory } from './models.js';
import type { MemoryType } from '../types.js';
import { normalizeContent, normalizeWhitespace, summarize, tokenize } from '../utils/text.js';

export function extractMemoryCandidates(userText: string, assistantText: string): ExtractedMemory[] {
  const results: ExtractedMemory[] = [];
  const normalizedUser = userText.trim();

  if (normalizedUser.length > 0) {
    const profilePattern = /(^profile:|my name is|call me|i go by|\u6211\u53eb|\u6211\u7684\u540d\u5b57\u662f|\u540d\u5b57\u662f|\u79f0\u547c\u6211)/i;
    const preferencePattern = /(prefer|always|never|please use|remember|default to|\u8bf7\u7528|\u4ee5\u540e|\u8bb0\u4f4f|\u9ed8\u8ba4|\u4e0d\u8981|\u5fc5\u987b)/i;
    const rulePattern = /(rule|constraint|must|should|require|\u89c4\u8303|\u7ea6\u675f|\u5fc5\u987b|\u7981\u6b62)/i;

    if (profilePattern.test(normalizedUser)) {
      results.push({
        scope: 'user',
        type: 'fact',
        content: normalizeWhitespace(normalizedUser),
        summary: summarize(normalizedUser, 120),
        keywords: tokenize(normalizedUser),
        confidence: 0.78,
        importance: 0.78,
      });
    } else if (preferencePattern.test(normalizedUser) || rulePattern.test(normalizedUser)) {
      const summary = summarize(normalizedUser, 120);
      const type: MemoryType = rulePattern.test(normalizedUser) ? 'rule' : 'preference';
      const scope = type === 'rule' ? 'user' : 'session';

      results.push({
        scope,
        type,
        content: normalizeWhitespace(normalizedUser),
        summary,
        keywords: tokenize(normalizedUser),
        confidence: 0.72,
        importance: type === 'rule' ? 0.8 : 0.65,
      });
    }
  }

  const normalizedAssistant = assistantText.trim();
  if (normalizedAssistant.length > 0) {
    const fixPattern = /(fixed|resolved|workaround|root cause|\u5df2\u4fee\u590d|\u95ee\u9898\u539f\u56e0|\u89e3\u51b3\u65b9\u6848)/i;
    if (fixPattern.test(normalizedAssistant)) {
      results.push({
        scope: 'session',
        type: 'fix',
        content: summarize(normalizedAssistant, 180),
        summary: summarize(normalizedAssistant, 100),
        keywords: tokenize(normalizedAssistant),
        confidence: 0.7,
        importance: 0.65,
      });
    }

    const decisionPattern = /(decide|decision|choose|selected|we will|plan is|adopt|\u91c7\u7528|\u51b3\u5b9a|\u65b9\u6848\u662f)/i;
    if (decisionPattern.test(normalizedAssistant)) {
      results.push({
        scope: 'session',
        type: 'decision',
        content: summarize(normalizedAssistant, 180),
        summary: summarize(normalizedAssistant, 100),
        keywords: tokenize(normalizedAssistant),
        confidence: 0.68,
        importance: 0.62,
      });
    }
  }

  return dedupeExtracted(results);
}

function dedupeExtracted(items: ExtractedMemory[]): ExtractedMemory[] {
  const seen = new Set<string>();
  const deduped: ExtractedMemory[] = [];
  for (const item of items) {
    const key = normalizeContent(item.content);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}
