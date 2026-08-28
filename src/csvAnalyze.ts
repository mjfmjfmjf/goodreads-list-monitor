import { createReadStream, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { splitCsvLine, openCsvStream } from './importData.js';

// Field-level analysis for a CSV (plain or gzipped) file. Single streaming pass,
// memory-safe for large files. Reports population, non-blank %, type guess,
// numeric min/max, and a small sample of distinct values.

export interface FieldStat {
  name: string;
  populated: number;
  pct: string;
  type: 'number' | 'json' | 'text';
  numericMin?: string;
  numericMax?: string;
  sample: string[];
}

export interface CsvAnalysis {
  path: string;
  gzBytes: number;
  rowCount: number;
  colCount: number;
  fields: FieldStat[];
}

const BLANKISH = new Set(['', 'unknown', 'null', 'n/a', '{}', '[]']);

export async function analyzeCsv(file: string): Promise<CsvAnalysis> {
  const gzBytes = statSync(file).size;
  const rl = createInterface({ input: openCsvStream(file), crlfDelay: Infinity });

  let headers: string[] | null = null;
  let rowCount = 0;
  // per-column accumulators
  let cols: string[] = [];
  const populated = new Map<number, number>();
  const nums = new Map<number, { min: number; max: number }>();
  const types = new Map<number, 'number' | 'json' | 'text' | 'mixed'>();
  const samples = new Map<number, Set<string>>();
  const SAMPLE_CAP = 5;

  for await (const line of rl) {
    const fields = splitCsvLine(line);
    if (!headers) {
      headers = fields.map(f => f ?? '');
      cols = headers;
      continue;
    }
    rowCount++;
    for (let i = 0; i < cols.length; i++) {
      const raw = fields[i] ?? '';
      const v = raw.trim();
      if (v !== '') {
        populated.set(i, (populated.get(i) || 0) + 1);
        // type classification
        const cur = types.get(i);
        if (/^-?\d+([.,]\d+)?$/.test(v)) {
          const n = parseFloat(v.replace(/,/g, ''));
          const m = nums.get(i) || { min: Infinity, max: -Infinity };
          m.min = Math.min(m.min, n); m.max = Math.max(m.max, n);
          nums.set(i, m);
          if (cur && cur !== 'number') types.set(i, cur === 'json' ? 'mixed' : cur);
          else types.set(i, 'number');
        } else if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
          if (cur && cur !== 'json') types.set(i, 'mixed');
          else types.set(i, 'json');
        } else {
          if (cur === 'number' || cur === 'json') types.set(i, 'mixed');
          else types.set(i, 'text');
        }
        // sample distinct values
        if (!BLANKISH.has(v.toLowerCase()) && (samples.get(i)?.size || 0) < SAMPLE_CAP) {
          const s = samples.get(i) || new Set<string>();
          if (s.size < SAMPLE_CAP) { s.add(v.slice(0, 30)); samples.set(i, s); }
        }
      }
    }
  }

  const fields: FieldStat[] = cols.map((name, i) => {
    const pop = populated.get(i) || 0;
    const pct = rowCount > 0 ? ((pop / rowCount) * 100).toFixed(1) + '%' : '0.0%';
    let type = types.get(i) as FieldStat['type'] | 'mixed' | undefined;
    if (!type) type = 'text';
    if (type === 'mixed') type = 'text';
    const num = nums.get(i);
    return {
      name,
      populated: pop,
      pct,
      type,
      numericMin: num ? String(num.min) : undefined,
      numericMax: num ? String(num.max) : undefined,
      sample: samples.get(i) ? [...samples.get(i)!] : [],
    };
  });

  return { path: file, gzBytes, rowCount, colCount: cols.length, fields };
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1024 * 1024) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

export function printAnalysis(a: CsvAnalysis): void {
  console.log(chalk.cyan.bold(`\n📊 CSV Analysis: ${a.path}`));
  console.log(chalk.gray(`   rows: ${a.rowCount.toLocaleString('en-US')} | cols: ${a.colCount} | gz size: ${fmtBytes(a.gzBytes)}`));
  const rule = '-'.repeat(6 + 10 + 7 + 7 + 14 + 34);
  console.log(chalk.gray(rule));
  console.log(chalk.white('COLUMN'.padEnd(24) + ' | ' + 'POP'.padStart(10) + ' | ' + 'POP%'.padStart(6) + ' | ' + 'TYPE'.padStart(5) + ' | ' + 'NUM RANGE'.padEnd(13) + ' | SAMPLE'));
  console.log(chalk.gray(rule));
  for (const f of a.fields) {
    const pop = chalk.yellow(f.populated.toLocaleString('en-US').padStart(10));
    const pct = chalk.cyan(f.pct.padStart(6));
    const ty = chalk.gray(f.type.padStart(5));
    const range = chalk.magenta((f.numericMin !== undefined ? `${f.numericMin}..${f.numericMax}` : '').padEnd(13));
    const sample = f.sample.join(', ').slice(0, 34);
    console.log(chalk.white(f.name.slice(0, 24).padEnd(24)) + ' | ' + pop + ' | ' + pct + ' | ' + ty + ' | ' + range + ' | ' + sample);
  }
  console.log(chalk.gray(rule));
}
