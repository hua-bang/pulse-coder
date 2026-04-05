import { describe, expect, it } from 'vitest';
import { unescapeContentArg } from '../node';

describe('unescapeContentArg', () => {
  it('converts literal \\n into real newlines', () => {
    expect(unescapeContentArg('# Title\\n\\n## Section')).toBe('# Title\n\n## Section');
  });

  it('handles \\r, \\t, \\\\ and quote escapes', () => {
    expect(unescapeContentArg('a\\tb\\rc\\\\d\\"e\\\'f\\`g')).toBe('a\tb\rc\\d"e\'f`g');
  });

  it('leaves real newlines and unrelated backslashes alone', () => {
    expect(unescapeContentArg('real\nnewline\\x')).toBe('real\nnewline\\x');
  });

  it('returns empty string unchanged', () => {
    expect(unescapeContentArg('')).toBe('');
  });

  it('handles the reported markdown bug example', () => {
    const input = '# AI Agent\\n\\n## 定义\\n- **AI Agent** 指具备自主感知能力';
    const out = unescapeContentArg(input);
    expect(out).toBe('# AI Agent\n\n## 定义\n- **AI Agent** 指具备自主感知能力');
    expect(out).toContain('\n\n');
    expect(out).not.toContain('\\n');
  });
});
