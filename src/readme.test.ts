import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderColorLegend } from './readme.js';

// Strip ANSI escape codes so we can assert on the visible text.
function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('renderMarkdown', () => {
  it('renders h1 with a bold rule above the title', () => {
    const out = stripAnsi(renderMarkdown('# Hello'));
    expect(out).toContain('━'.repeat(72));
    expect(out.indexOf('━'.repeat(72))).toBeLessThan(out.indexOf('Hello'));
  });

  it('renders h2 with a gray rule above the title', () => {
    const out = stripAnsi(renderMarkdown('## Section'));
    expect(out.indexOf('─'.repeat(72))).toBeLessThan(out.indexOf('Section'));
  });

  it('renders h3 with a light dotted separator above the title', () => {
    const out = stripAnsi(renderMarkdown('### Subsection'));
    expect(out.indexOf('· '.repeat(16).trimEnd())).toBeLessThan(out.indexOf('Subsection'));
  });

  it('strips bold and inline code', () => {
    const out = renderMarkdown('Use **bold** and `code` here.');
    expect(stripAnsi(out)).toContain('Use bold and code here.');
  });

  it('removes markdown link syntax while keeping label and url', () => {
    const out = renderMarkdown('[opencode](https://opencode.ai)');
    expect(stripAnsi(out)).toContain('opencode (https://opencode.ai)');
  });

  it('renders bullets with a prefix', () => {
    const out = renderMarkdown('- one\n- two');
    const lines = stripAnsi(out).split('\n');
    expect(lines[0]).toContain('•');
    expect(stripAnsi(out)).toContain('one');
    expect(stripAnsi(out)).toContain('two');
  });

  it('renders code fences as plain gray block, keeping content', () => {
    const out = renderMarkdown('```bash\nnpm test\n```');
    expect(stripAnsi(out)).toContain('npm test');
    expect(stripAnsi(out)).not.toContain('```');
  });

  it('renders horizontal rules', () => {
    const out = renderMarkdown('---');
    expect(out).toContain('---');
  });

  it('handles empty input', () => {
    expect(stripAnsi(renderMarkdown(''))).toBe('');
  });
});

describe('renderColorLegend', () => {
  it('includes every documented color', () => {
    const text = stripAnsi(renderColorLegend());
    for (const name of ['Yellow', 'Green', 'Cyan', 'Magenta', 'Gray', 'White', 'Red', 'Dim', 'Blue', 'Red bg']) {
      expect(text).toContain(name);
    }
  });

  it('mentions CUM >= and the critical banner', () => {
    const text = stripAnsi(renderColorLegend());
    expect(text).toContain('CUM >=');
    expect(text).toContain('warning banner');
  });
});