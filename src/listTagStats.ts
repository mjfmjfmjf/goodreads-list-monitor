import chalk from 'chalk';
import { getDb } from './db.ts';
import { countListTagWalks, loadWalkedTagNames, loadWalkTagStats } from './storage.ts';

export interface ListTagRankingOptions {
  limit?: string;
  minLists?: string;
  // Drop tags already used as a Listopia walk tag. These are the tags you've
  // already enumerated lists through, so their list_tags counts are work you
  // chose to do — usually noise in a "what tags are on lists" report.
  excludeWalked?: boolean;
}

export interface RankedListTag {
  tagName: string;
  lists: number;
  // How many of that tag's lists we have actually read tags for, i.e. lists whose
  // list_tags row is fresh. A tag on a list we read once a year ago is weaker
  // evidence than one read yesterday.
  everSeen: number;
  lastSeen: string;
}

// Rank tags by how many lists carry them.
//
// Pure over its input so the ranking rules are unit-testable without a DB.
export function rankListTags(
  rows: { tagName: string; lists: number; lastSeen: string }[],
  options: ListTagRankingOptions = {},
  walkedTags: string[] = [],
): RankedListTag[] {
  const minLists = parseInt(options.minLists || '1', 10) || 1;
  // Compare case-insensitively on both sides: Goodreads treats /show_tag/Dutch
  // and /show_tag/dutch as the same tag, so a walked tag spelled with any
  // capitalization must still be excluded from the report.
  const excluded = options.excludeWalked
    ? new Set(walkedTags.map((t) => t.toLowerCase()))
    : new Set<string>();
  const out = rows
    .filter((r) => r.lists >= minLists && !excluded.has(r.tagName.toLowerCase()))
    .map((r) => ({ ...r, everSeen: r.lists }))
    // Most lists first; ties broken by tag name so the output is stable run to run
    // (SQLite does not guarantee a tie order, and a report that reshuffles on
    // every invocation is unreadable when you're diffing two runs).
    .sort((a, b) => (b.lists !== a.lists ? b.lists - a.lists : a.tagName.localeCompare(b.tagName)));
  return out;
}

export function loadTagListCounts(minLists: number): { tagName: string; lists: number; lastSeen: string }[] {
  return getDb().prepare(`
    SELECT tag_name AS tagName, COUNT(*) AS lists, MAX(last_seen) AS lastSeen
    FROM list_tags
    GROUP BY tag_name
    HAVING COUNT(*) >= @minLists
    ORDER BY lists DESC, tag_name ASC
  `).all({ minLists }) as { tagName: string; lists: number; lastSeen: string }[];
}

const fmtAge = (lastSeen: string): string => {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(lastSeen)) / 86400000));
  if (!Number.isFinite(days)) return 'unknown';
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

export async function runListTagStats(options: ListTagRankingOptions = {}): Promise<void> {
  console.log(chalk.cyan.bold(`\n🏷️  List tags by number of lists`));

  const minLists = parseInt(options.minLists || '1', 10) || 1;
  const limit = parseInt(options.limit || '25', 10);

  const totals = getDb().prepare(`
    SELECT COUNT(DISTINCT list_id) AS lists, COUNT(DISTINCT tag_name) AS tags FROM list_tags
  `).get() as { lists: number; tags: number };

  if (!totals.tags) {
    console.log(chalk.yellow('\n   No list_tags rows yet — run ./listTagBackfill.sh to collect them.'));
    return;
  }

  const all = loadTagListCounts(minLists);
  const walkedTags = loadWalkedTagNames();
  const walked = rankListTags(all, options, walkedTags);
  const ranked = walked.slice(0, limit);
  const excludedCount = all.length - walked.length;

  console.log(chalk.gray(`   ${totals.lists.toLocaleString()} lists tagged · ${totals.tags.toLocaleString()} distinct tags`));
  const criteria = [`min lists per tag: ${minLists.toLocaleString()}`];
  if (options.excludeWalked) {
    criteria.push(`excluding ${excludedCount.toLocaleString()} already-walked tag${excludedCount === 1 ? '' : 's'}`);
  }
  console.log(
    chalk.gray(
      `   Showing ${ranked.length.toLocaleString()} of ${walked.length >= limit ? '≥' : ''}${walked.length.toLocaleString()} matching tags · ${criteria.join(' · ')}`,
    ),
  );
  console.log(chalk.gray('------------------------------------------'));

  if (ranked.length === 0) {
    console.log(chalk.yellow('   No tags match the criteria.'));
    return;
  }

  const max = ranked[0].lists;
  const walkStats = loadWalkTagStats();
  for (let i = 0; i < ranked.length; i++) {
    const t = ranked[i];
    const bar = '█'.repeat(Math.max(1, Math.round((t.lists / max) * 20)));
    const count = chalk.yellow.bold(t.lists.toLocaleString().padStart(5));
    // Walk status comes from list_tag_walk_history (when the walk ran and how
    // many lists the directory yielded). The count above is the unified xref —
    // sidebar reads and directory walks in one table — so once a tag has been
    // walked its count reflects the directory too, not just the lists whose
    // sidebars we happened to read. Suppressed under --exclude-walked: every
    // row shown there is by construction never walked.
    let walkNote = '';
    if (!options.excludeWalked) {
      const walk = walkStats.get(t.tagName.toLowerCase());
      if (!walk) walkNote = chalk.gray(' · never walked');
      else {
        const walksNote = walk.walks === 1 ? '1 walk' : `${walk.walks.toLocaleString()} walks`;
        if (walk.lists > 0) walkNote = chalk.gray(` · walked ${walk.lists.toLocaleString()} lists · ${walksNote} · ${fmtAge(walk.walkedAt)}`);
        else walkNote = chalk.gray(` · ${walksNote} (membership unknown) · ${fmtAge(walk.walkedAt)}`);
      }
    }
    console.log(`${(i + 1).toString().padStart(4, ' ')}. ${t.tagName.padEnd(28, ' ')} ${count} ${chalk.gray(bar)} ${chalk.gray(`(${fmtAge(t.lastSeen)})`)}${walkNote}`);
  }

  console.log(chalk.gray('------------------------------------------'));

  if (options.excludeWalked) {
    const { tags, withMembership } = countListTagWalks();
    console.log(
      chalk.gray(
        `   Walked tags on record: ${tags.toLocaleString()} (${withMembership.toLocaleString()} with their list membership).`,
      ),
    );
  }
}