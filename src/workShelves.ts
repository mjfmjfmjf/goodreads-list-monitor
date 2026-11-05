import chalk from 'chalk';
import { getDb } from './db.ts';
import { scrapeWorkShelvesSafe } from './scraper.ts';
import { delay } from './utils.ts';
import { upsertWorkShelfTags } from './storage.ts';

export interface WorkShelvesOptions {
  limit?: string;
  minRatings?: string;
  maxAgeDays?: string;
  dryRun?: boolean;
}

interface WorkToScrape {
  workId: string;
  id: string;
  ratings: number;
  title: string | null;
  author: string | null;
}

function getBooksToScrape(minRatings: number, maxAgeDays: number, limit: number): WorkToScrape[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  // Scrape by work_id, but dedupe to one entry per conceptual work
  // (title+author) to avoid hitting multiple work_ids for translations/editions
  // of the same book. Prefer English, then highest ratings.
  const stmt = db.prepare(`
    WITH reps AS (
      SELECT b.work_id AS workId,
             b.id,
             CAST(REPLACE(COALESCE(b.ratings, '0'), ',', '') AS INTEGER) AS ratingsNum,
             b.title,
             b.author,
             bp.language
      FROM books b
      LEFT JOIN book_page bp ON bp.book_id = b.id
      WHERE b.is_work_rep = 1
        AND b.work_id IS NOT NULL
        AND TRIM(b.work_id) != ''
        AND CAST(REPLACE(COALESCE(b.ratings, '0'), ',', '') AS INTEGER) >= ?
    ),
    deduped AS (
      SELECT *,
             ROW_NUMBER() OVER (
               PARTITION BY LOWER(TRIM(COALESCE(title, ''))), LOWER(TRIM(COALESCE(author, '')))
               ORDER BY ratingsNum DESC,
                        (CASE WHEN language LIKE 'English%' THEN 1 ELSE 0 END) DESC,
                        workId
             ) AS rn
      FROM reps
    )
    SELECT d.workId, d.id, d.ratingsNum, d.title, d.author
    FROM deduped d
    LEFT JOIN work_shelf_scrapes w ON w.book_id = d.workId
    WHERE d.rn = 1
      AND (w.book_id IS NULL OR w.scraped_at < ?)
    ORDER BY d.ratingsNum DESC, d.workId
    LIMIT ?
  `);

  const rows = stmt.all(minRatings, cutoff, limit) as any[];
  return rows.map(r => ({
    workId: r.workId,
    id: r.id,
    ratings: r.ratingsNum,
    title: r.title || null,
    author: r.author || null,
  }));
}

export async function runWorkShelves(options: WorkShelvesOptions = {}): Promise<void> {
  const limit = options.limit ? parseInt(options.limit, 10) : 100;
  const minRatings = options.minRatings ? parseInt(options.minRatings, 10) : 1000;
  const maxAgeDays = options.maxAgeDays ? parseInt(options.maxAgeDays, 10) : 30;
  
  console.log(chalk.cyan.bold('\n📚 Work Shelves Scraper (page 1 only)'));
  console.log(chalk.gray(`   Min ratings: ${minRatings.toLocaleString()}, Max age: ${maxAgeDays} days, Limit: ${limit}`));
  console.log(chalk.gray('   Reading https://www.goodreads.com/work/shelves/<workId> (top shelves by popularity)'));
  
  if (options.dryRun) {
    console.log(chalk.yellow('   DRY RUN - no requests will be made'));
    const works = getBooksToScrape(minRatings, maxAgeDays, limit);
    console.log(chalk.gray(`   Would scrape ${works.length} works`));
    for (const w of works.slice(0, 10)) {
      const label = w.title ? (w.author ? `${w.title} by ${w.author}` : w.title) : w.id;
      console.log(chalk.gray(`     work ${w.workId} — ${label} (${w.ratings.toLocaleString()} ratings)`));
    }
    if (works.length > 10) console.log(chalk.gray(`     ... and ${works.length - 10} more`));
    return;
  }
  
  const works = getBooksToScrape(minRatings, maxAgeDays, limit);
  console.log(chalk.gray(`   Found ${works.length} works to scrape\n`));

  let consecutiveProtected = 0;
  let scraped = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < works.length; i++) {
    const work = works[i];
    const label = work.title ? (work.author ? `${work.title} by ${work.author}` : work.title) : `book ${work.id}`;
    console.log(chalk.cyan(`[${i + 1}/${works.length}] Scraping work shelves for work ${work.workId} — ${label} (${work.ratings.toLocaleString()} ratings)...`));

    const scrapeStart = Date.now();
    const result = await scrapeWorkShelvesSafe(work.workId);
    console.log(chalk.gray(`     (${Date.now() - scrapeStart}ms total)`));
    
    if (result.protected) {
      consecutiveProtected++;
      console.log(chalk.yellow(`   ⚠️  Protected/throttled (consecutive: ${consecutiveProtected})`));
      if (consecutiveProtected >= 2) {
        console.log(chalk.red.bold('\n🛑 Appears protected by Goodreads, giving up for now until proven otherwise'));
        break;
      }
      await delay(2000, 4000);
      continue;
    }

    consecutiveProtected = 0;

    if (!result.ok) {
      failed++;
      console.log(chalk.red('   ❌ Failed to fetch'));
      // Record as scraped to avoid retrying failed/dead pages every run
      try {
        const { recordWorkShelfScrape } = await import('./storage.ts');
        recordWorkShelfScrape(work.workId, 0);
      } catch (e) {
        // ignore
      }
      await delay(2000, 4000);
      continue;
    }

    if (result.entries.length === 0) {
      skipped++;
      console.log(chalk.gray('   No shelf entries found (marking as scraped)'));
      // Record as scraped even if empty to avoid retrying
      const { recordWorkShelfScrape } = await import('./storage.ts');
      recordWorkShelfScrape(work.workId, 0);
      await delay(2000, 4000);
      continue;
    }

    upsertWorkShelfTags(work.workId, result.entries);
    scraped++;
    console.log(chalk.green(`   ✅ Saved ${result.entries.length} shelf tags to work_tag_books`));

    // Polite delay between works
    await delay(2000, 4000);
  }
  
  console.log(chalk.cyan.bold('\n📊 Summary:'));
  console.log(chalk.gray(`   Scraped: ${scraped}`));
  console.log(chalk.gray(`   Skipped (empty): ${skipped}`));
  console.log(chalk.gray(`   Failed: ${failed}`));
  console.log(chalk.gray(`   Total processed: ${scraped + skipped + failed}`));
}
