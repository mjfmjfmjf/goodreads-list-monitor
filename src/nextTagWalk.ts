import chalk from 'chalk';
import { loadTagListCounts, rankListTags, type RankedListTag } from './listTagStats.ts';
import { loadWalkedTagNames } from './storage.ts';
import { runListTagWalker } from './listTagWalker.ts';
import { withConnectivityProbe } from './utils.ts';

export interface NextTagWalkOptions {
  // Drop tags carried by fewer than this many lists before ranking (default 1).
  minLists?: number;
  // Passed through to the tag walk: skip lists scraped within the last
  // skip-days days (default 100).
  skipDays?: number;
  dryRun?: boolean;
  pageStart?: number;
  pageEnd?: number;
  listMaxPages?: number;
}

// Every tag that has NOT yet been used as a Listopia walk tag, ranked by the
// ./listTagStats.sh --exclude-walked order: most lists first, ties by name.
// Pure over its inputs so the ranking rules are unit-testable without a DB.
export function unwalkedTags(
  rows: { tagName: string; lists: number; lastSeen: string }[],
  walkedTags: string[],
  minLists = 1,
): RankedListTag[] {
  return rankListTags(rows, { minLists: String(minLists), excludeWalked: true }, walkedTags);
}

export async function runNextTagWalk(options: NextTagWalkOptions = {}): Promise<void> {
  const minLists = options.minLists ?? 1;
  const skipDays = options.skipDays ?? 100;
  const dryRun = !!options.dryRun;

  console.log(chalk.cyan.bold(`\n🎯 Unwalked Listopia tags (biggest first, walked tags excluded)`));

  const min = Math.max(1, Math.floor(minLists)) || 1;
  const all = loadTagListCounts(min);
  if (all.length === 0) {
    console.log(chalk.yellow('\n   No list_tags rows yet — run ./listTagBackfill.sh to collect them.'));
    return;
  }

  const walkedTags = loadWalkedTagNames();
  const candidates = unwalkedTags(all, walkedTags, min);

  if (candidates.length === 0) {
    console.log(chalk.yellow(`   All ${all.length.toLocaleString()} tags with ≥ ${min.toLocaleString()} lists have been walked — nothing new to pick.`));
    return;
  }

  console.log(chalk.grey(`   ${candidates.length.toLocaleString()} unwalked tags · skipping lists scraped < ${skipDays}d ago (candidates ≥ ${min.toLocaleString()} lists)`));

  if (dryRun) {
    const width = String(candidates.length).length;
    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i];
      console.log(`   ${String(i + 1).padStart(width, ' ')}. ${t.tagName.padEnd(28, ' ')} ${chalk.yellow.bold(t.lists.toLocaleString().padStart(5))} lists`);
      if (i >= 499) {
        console.log(chalk.grey(`   … and ${candidates.length - 500} more (this run would walk them in order)`));
        break;
      }
    }
    console.log(chalk.yellow(`\n   Dry run — ${candidates.length.toLocaleString()} unwalked tag${candidates.length === 1 ? '' : 's'} found; run without --dryRun to walk ${candidates.length === 1 ? 'it' : 'them all'}, biggest first.`));
    return;
  }

  // Walk every unwalked tag via the list-tag-walk engine. Membership + walk
  // history are recorded UP FRONT by the walker (before the skipDays loop), so
  // a crash mid-tag or mid-run resumes cleanly: the next invocation only sees
  // tags that were never started. A connectivity outage is probed + waited out
  // like every other crawler, not spelled as a tag-level failure.
  for (let i = 0; i < candidates.length; i++) {
    const pick = candidates[i];
    console.log(chalk.white.bold(`\n──────────────────────── ${i + 1} of ${candidates.length} ────────────────────────`));
    try {
      await withConnectivityProbe(
        async () => runListTagWalker({
          tag: pick.tagName,
          startPage: options.pageStart ?? 1,
          endPage: options.pageEnd,
          listMaxPages: options.listMaxPages,
          skipDays,
        }),
        { label: `tag "${pick.tagName}"` },
      );
    } catch (error: any) {
      console.error(chalk.red.bold(`\n   ⛔ Tag "${pick.tagName}" aborted the run: ${error?.message}`));
      console.error(chalk.red('   Earlier tags are saved (each is recorded when its walk starts). Re-run to continue with the next unwalked tag.'));
      throw error;
    }
  }

  console.log(chalk.cyan.bold(`\n🏁 Finished — all ${candidates.length.toLocaleString()} unwalked tags walked.`));
}