import chalk from 'chalk';
import { getDb } from './db.ts';

export interface ListTagsOptions {
  limit?: string | number;
}

export interface TagCount {
  tagName: string;
  lists: number;
}

export const DEFAULT_LIST_TAGS_LIMIT = 30;

// Clamp the --limit argument: a missing/unparseable/negative value falls back
// to the default rather than printing nothing (limit 0 meaning "unlimited" is a
// trap for a flag whose default is a small number).
export function resolveLimit(limit: string | number | undefined): number {
  const n = parseInt(String(limit ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIST_TAGS_LIMIT;
}

// Pure so the sort order is unit-testable without a DB: most lists first, ties
// broken by tag name so two runs print identically and can be diffed (SQLite
// does not guarantee a tie order).
export function sortTagCounts(rows: TagCount[]): TagCount[] {
  return [...rows].sort((a, b) =>
    b.lists !== a.lists ? b.lists - a.lists : a.tagName.localeCompare(b.tagName),
  );
}

export function loadTagCounts(): TagCount[] {
  return getDb().prepare(`
    SELECT tag_name AS tagName, COUNT(*) AS lists
    FROM list_tags
    GROUP BY tag_name
    ORDER BY lists DESC, tag_name ASC
  `).all() as TagCount[];
}

export function formatTagCountLine(rank: number, row: TagCount): string {
  return `${rank.toString().padStart(4, ' ')}. ${row.tagName.padEnd(28, ' ')} ${row.lists.toLocaleString().padStart(6)}`;
}

export async function runListTags(options: ListTagsOptions = {}): Promise<void> {
  const limit = resolveLimit(options.limit);
  const all = sortTagCounts(loadTagCounts());
  const rows = all.slice(0, limit);

  console.log(chalk.cyan.bold(`\n🏷️  Tags → number of lists`));
  if (all.length === 0) {
    console.log(chalk.yellow('\n   No list_tags rows yet — run ./listTagBackfill.sh to collect them.'));
    return;
  }

  const totals = getDb().prepare(
    `SELECT COUNT(DISTINCT list_id) AS lists FROM list_tags`,
  ).get() as { lists: number };
  console.log(
    chalk.gray(
      `   ${totals.lists.toLocaleString()} lists tagged · ${all.length.toLocaleString()} distinct tags · showing top ${rows.length.toLocaleString()}`,
    ),
  );
  console.log(chalk.gray('------------------------------------------'));

  for (let i = 0; i < rows.length; i++) {
    console.log(formatTagCountLine(i + 1, rows[i]));
  }
}
