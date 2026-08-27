import fs from 'fs-extra';
import chalk from 'chalk';
import path from 'path';

// Lightweight markdown → terminal renderer tuned for README output.
// Handles headings, bold, italic, inline code, links, bullets, blockquotes,
// code fences, and horizontal rules. Everything else passes through.
export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeFence = false;
  let codeLines: string[] = [];

  const flushCode = () => {
    if (codeLines.length) {
      out.push(chalk.gray(codeLines.join('\n')));
      codeLines = [];
    }
  };

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (/^```/.test(trimmed)) {
      if (inCodeFence) {
        flushCode();
        inCodeFence = false;
      } else {
        flushCode();
        inCodeFence = true;
      }
      continue;
    }
    if (inCodeFence) {
      codeLines.push(raw);
      continue;
    }
    if (!trimmed) {
      out.push('');
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      out.push(chalk.gray('-'.repeat(72)));
      continue;
    }

    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const text = inlineFormat(h[2]);
      const level = h[1].length;
      if (level === 1) {
        out.push('', chalk.cyan.bold('━'.repeat(72)), chalk.cyan.bold(text), '');
      } else if (level === 2) {
        out.push('', chalk.gray('─'.repeat(72)), chalk.cyan.bold(text), '');
      } else if (level === 3) {
        out.push('', chalk.dim('· '.repeat(16)), chalk.cyan.bold(text), '');
      } else {
        out.push(chalk.cyan.bold('  ' + text));
      }
      continue;
    }

    if (/^\s*[-*]\s+/.test(raw)) {
      out.push(chalk.white('  • ') + inlineFormat(raw.replace(/^\s*[-*]\s+/, '')));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(raw)) {
      out.push(chalk.white('  ' + inlineFormat(raw)));
      continue;
    }
    if (/^\s*>\s?/.test(raw)) {
      out.push(chalk.gray(inlineFormat(raw.replace(/^\s*>\s?/, ''))));
      continue;
    }

    out.push(inlineFormat(raw));
  }

  flushCode();
  return out.join('\n');
}

// Inline: `code`, **bold**, *italic*, [label](url).
function inlineFormat(s: string): string {
  let t = s;
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => chalk.cyan(c));
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => chalk.bold(b));
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, (_m, pre: string, i: string) => pre + chalk.dim(i));
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => `${label} ${chalk.gray(`(${url})`)}`);
  return t;
}

export function readmePath(): string {
  const p = path.join(process.cwd(), 'README.md');
  if (!fs.existsSync(p)) {
    throw new Error(`No README.md found at ${p}`);
  }
  return p;
}

export function runReadme(): void {
  const content = fs.readFileSync(readmePath(), 'utf8');
  console.log(renderMarkdown(content));
}

export function renderColorLegend(): string {
  const rows: Array<[string, string, string]> = [
    [chalk.yellow('■'), 'Yellow', 'raw counts from the cache (books, ratings, reviews, shelves)'],
    [chalk.green('■'), 'Green', 'derived/modeled values & success states (avg ratings, estimates, "updated")'],
    [chalk.cyan('■'), 'Cyan', 'percentages & supporting context (share of total, completeness, cache %)'],
    [chalk.magenta('■'), 'Magenta', 'emphasized cumulative/total figure in a row (e.g. CUM >=)'],
    [chalk.gray('■'), 'Gray', 'zeros, empty cells, timers, and background detail'],
    [chalk.white('■'), 'White', 'names, labels, and list nicknames'],
    [chalk.red('■'), 'Red', 'errors, failures, removed/outlier books, and "Unknown" values'],
    [chalk.dim('■'), 'Dim', 'muted scrape progress sublines (e.g. per-page author crawl lines)'],
    [chalk.blue('■'), 'Blue', 'one-off section headings (e.g. "Out of position" in author list diffs)'],
    [chalk.bgRed.white('■'), 'Red bg', 'critical Goodreads site-structure warning banner — stop and check'],
  ];

  const nameWidth = Math.max(...rows.map(r => r[1].length));
  const lines = [
    '',
    chalk.bold('🎨 Output Color Legend'),
    '',
    ...rows.map(([swatch, name, desc]) => `  ${swatch}  ${chalk.bold(name.padEnd(nameWidth))}  - ${desc}`),
    '',
  ];
  return lines.join('\n');
}

export function runColorLegend(): void {
  console.log(renderColorLegend());
}