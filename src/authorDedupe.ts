import chalk from 'chalk';
import { getDb } from './db.js';

// ── Author identity consolidation ─────────────────────────────────────────
// authors.name is the primary key, but names arrive from scraped book rows
// where markup variants ("John   Williams", "Hope Larson(Adapter, Illustrator)")
// multiply one author id into several rows. Stats can land on one variant
// while rankings read another, so authors silently drop out of top-N lists.
//
// author-dedupe merges every duplicate-id group into a single canonical row
// (preferring rows that carry stats and clean names) and un-mangles remaining
// names. Dry-run by default; pass --apply to write.

export interface AuthorRow {
  name: string;
  id: string;
  slug: string;
  lastSeen: string;
  averageRating?: number | null;
  numRatings?: number | null;
  numReviews?: number | null;
  numShelves?: number | null;
}

export interface ConsolidationPlan {
  keep: AuthorRow;
  drop: AuthorRow[];
  finalName: string;
}

export interface RenamePlan {
  from: string;
  to: string;
}

const MANGLED_RE = /\S\s{2,}\S/;

export function collapseName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

function hasStats(row: AuthorRow): boolean {
  return Boolean(row.averageRating && (row.numRatings || 0) > 0);
}

function cleanliness(row: AuthorRow): number {
  let score = 0;
  if (!MANGLED_RE.test(row.name)) score += 2;
  if (!row.name.includes('(')) score += 1;
  return score;
}

function rowFromDb(r: any): AuthorRow {
  return {
    name: r.name,
    id: String(r.id),
    slug: r.slug,
    lastSeen: r.last_seen,
    averageRating: r.average_rating,
    numRatings: r.num_ratings,
    numReviews: r.num_reviews,
    numShelves: r.num_shelves,
  };
}

export function planConsolidation(group: AuthorRow[]): ConsolidationPlan | undefined {
  if (group.length < 2) return undefined;
  const keep = [...group].sort((a, b) =>
    Number(hasStats(b)) - Number(hasStats(a)) ||
    cleanliness(b) - cleanliness(a) ||
    b.lastSeen.localeCompare(a.lastSeen) ||
    a.name.localeCompare(b.name)
  )[0];
  const drop = group.filter(r => r !== keep);
  // The keeper maximizes stats, so collapsing its name preserves the best
  // data — no need to carry stats between variants.
  return { keep, drop, finalName: collapseName(keep.name) };
}

export function planRename(row: AuthorRow): RenamePlan | undefined {
  const to = collapseName(row.name);
  if (!to || to === row.name) return undefined;
  return { from: row.name, to };
}

interface Preview {
  plans: ConsolidationPlan[];
  renames: RenamePlan[];
  totalRows: number;
}

function loadGroups(db: import('better-sqlite3').Database): Map<string, AuthorRow[]> {
  const allRows = (db.prepare('SELECT name, id, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves FROM authors').all() as any[]).map(rowFromDb);
  const groups = new Map<string, AuthorRow[]>();
  for (const row of allRows) {
    const list = groups.get(row.id);
    if (list) list.push(row);
    else groups.set(row.id, [row]);
  }
  return groups;
}

export function previewConsolidation(db: import('better-sqlite3').Database): Preview {
  const groups = loadGroups(db);
  const plans: ConsolidationPlan[] = [];
  const renames: RenamePlan[] = [];
  let totalRows = 0;
  for (const group of groups.values()) {
    totalRows += group.length;
    const plan = planConsolidation(group);
    if (plan) plans.push(plan);
    else {
      const rename = planRename(group[0]);
      if (rename && !plans.some(p => p.finalName === rename.to)) renames.push(rename);
    }
  }
  return { plans, renames, totalRows };
}

export interface ApplyResult {
  mergedRows: number;
  renamed: number;
  skippedCollisions: string[];
}

export function applyConsolidation(db: import('better-sqlite3').Database): ApplyResult {
  const { plans, renames } = previewConsolidation(db);
  const result: ApplyResult = { mergedRows: 0, renamed: 0, skippedCollisions: [] };

  const delByName = db.prepare('DELETE FROM authors WHERE name = ?');
  const renameStmt = db.prepare('UPDATE authors SET name = ? WHERE name = ?');
  const idByName = db.prepare('SELECT id FROM authors WHERE name = ?');

  const tx = db.transaction(() => {
    for (const plan of plans) {
      for (const victim of plan.drop) {
        delByName.run(victim.name);
        result.mergedRows++;
      }
      if (plan.finalName !== plan.keep.name) {
        const occupant = idByName.get(plan.finalName) as any;
        if (occupant && String(occupant.id) !== plan.keep.id) {
          result.skippedCollisions.push(`${plan.keep.name} -> ${plan.finalName} (${plan.keep.id})`);
        } else if (!occupant) {
          renameStmt.run(plan.finalName, plan.keep.name);
        }
      }
    }
    for (const r of renames) {
      const occupant = idByName.get(r.to) as any;
      if (!occupant) {
        renameStmt.run(r.to, r.from);
        result.renamed++;
      }
    }
  });
  tx();
  return result;
}

export async function runAuthorDedupe(options: { apply?: boolean }): Promise<void> {
  const db = getDb();
  const { plans, renames, totalRows } = previewConsolidation(db);

  console.log(chalk.cyan.bold(`\n🧹 Author dedupe${options.apply ? ' (APPLY)' : ' (dry run)'}`));
  console.log(chalk.gray(`   ${totalRows} author rows, ${plans.length} duplicate groups, ${renames.length} mangled names`));

  const show = Math.min(8, plans.length);
  for (const p of plans.slice(0, show)) {
    const dropped = p.drop.map(d => JSON.stringify(d.name)).join(', ');
    console.log(chalk.gray(`   keep ${JSON.stringify(p.finalName)} (${p.keep.id}) — drops ${dropped}`));
  }
  if (plans.length > show) console.log(chalk.gray(`   … and ${plans.length - show} more`));

  if (!options.apply) {
    console.log(chalk.gray('\n   Dry run only. Rerun with --apply to write changes.'));
    return;
  }

  const backup = await import('./db.js');
  backup.backupDb();
  const result = applyConsolidation(db);
  console.log(chalk.green(`\n   ✅ Merged ${result.mergedRows} rows, renamed ${result.renamed}.`));
  if (result.skippedCollisions.length > 0) {
    console.log(chalk.yellow(`   ⚠️ Skipped ${result.skippedCollisions.length} renames that would collide:`));
    for (const c of result.skippedCollisions.slice(0, 5)) console.log(chalk.yellow(`      ${c}`));
  }
}
