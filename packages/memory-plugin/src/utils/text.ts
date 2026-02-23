export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function summarize(input: string, maxLength: number): string {
  const compact = normalizeWhitespace(input);
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

export function normalizeContent(input: string): string {
  return normalizeWhitespace(input).toLowerCase();
}

export function tokenize(input: string): string[] {
  return uniqueWords(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2)
      .slice(0, 30),
  );
}

export function uniqueWords(items: string[]): string[] {
  return [...new Set(items)].slice(0, 40);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
