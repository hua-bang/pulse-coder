function getValueByPath(source: unknown, pathExpr: string): unknown {
  if (!pathExpr) {
    return undefined;
  }

  const parts = pathExpr.split('.').filter(Boolean);
  let cursor: unknown = source;

  for (const key of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }

  return cursor;
}

export function safeToString(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function renderTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_raw, token) => {
    const value = getValueByPath(input, String(token));
    return safeToString(value);
  });
}
