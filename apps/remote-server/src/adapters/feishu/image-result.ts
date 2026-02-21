interface GeminiImageResult {
  outputPath: string;
  mimeType?: string;
}

export function extractGeminiImageResult(toolResult: unknown): GeminiImageResult | null {
  const toolName = extractToolName(toolResult);
  const payload = extractToolPayload(toolResult);

  if (!payload || !isRecord(payload)) {
    return null;
  }

  const outputPath = asString(payload.outputPath);
  if (!outputPath) {
    return null;
  }

  const mimeType = asString(payload.mimeType) ?? undefined;

  if (toolName && toolName !== 'gemini_pro_image') {
    return null;
  }

  if (!toolName && !looksLikeGeminiImagePayload(payload)) {
    return null;
  }

  return {
    outputPath,
    mimeType,
  };
}

function extractToolName(toolResult: unknown): string | null {
  if (!isRecord(toolResult)) {
    return null;
  }

  const topLevel = asString(toolResult.toolName) || asString(toolResult.name);
  if (topLevel) {
    return topLevel;
  }

  const nestedToolCall = isRecord(toolResult.toolCall) ? toolResult.toolCall : null;
  if (nestedToolCall) {
    return asString(nestedToolCall.toolName) || asString(nestedToolCall.name) || null;
  }

  return null;
}

function extractToolPayload(toolResult: unknown): unknown {
  if (!isRecord(toolResult)) {
    return null;
  }

  if (isRecord(toolResult.result)) {
    return toolResult.result;
  }

  if (isRecord(toolResult.output)) {
    return toolResult.output;
  }

  return toolResult;
}

function looksLikeGeminiImagePayload(payload: Record<string, unknown>): boolean {
  return (
    asString(payload.model) !== null
    && asString(payload.outputPath) !== null
    && asString(payload.mimeType)?.startsWith('image/') === true
  );
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
