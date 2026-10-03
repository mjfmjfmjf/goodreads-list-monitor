import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { findAuthorBySlug, upsertAuthor, updateAuthorStats, recordAuthorFailure, authorExistsById } from './storage.js';
import type { AuthorCacheEntry } from './storage.js';
import { scrapeAuthorStats } from './scraper.js';
import type { AuthorStatsResult } from './scraper.js';
import { delay, isConnectivityError, parseDelayRange } from './utils.js';

function parseAuthorInput(input: string): { id: string; slug: string } | undefined {
  const trimmed = input.trim();

  const urlMatch = trimmed.match(/\/author\/show\/([^?#\s/]+)/);
  if (urlMatch) {
    const slug = urlMatch[1];
    const id = slug.split('.')[0];
    return { id, slug };
  }

  const slugMatch = trimmed.match(/^(\d+)\.\S+$/);
  if (slugMatch) {
    return { id: slugMatch[1], slug: trimmed };
  }

  const idMatch = trimmed.match(/^(\d+)$/);
  if (idMatch) {
    return { id: idMatch[1], slug: idMatch[1] };
  }

  return undefined;
}

const fallbackNameFromSlug = (slug: string): string =>
  slug.split('.').slice(1).join('.').replace(/_/g, ' ');

interface AuthorOneOptions {
  multiPage?: boolean;
  withCookie?: boolean;
}

interface StoredAuthor {
  key: string;
  name: string;
  slug: string;
  changed: boolean;
  isNew: boolean;
  stats: AuthorStatsResult['stats'];
  prev: { averageRating?: string; numRatings?: string; numReviews?: string; numShelves?: string };
}

// Persist one scraped author page: create/merge the cache row and bump stats.
// Shared by the single-author command and the --file batch importer.
function storeAuthorStats(parsed: { id: string; slug: string }, result: AuthorStatsResult): StoredAuthor {
  const stats = result.stats;
  const slug = stats.slug || parsed.slug;
  const id = slug.split('.')[0];
  const name = stats.name || fallbackNameFromSlug(slug);

  const found = findAuthorBySlug(slug);
  const key = found?.key ?? name;
  const isNew = !found;
  const entry: AuthorCacheEntry = found?.entry ?? {
    id,
    slug,
    lastSeen: new Date().toISOString(),
  };

  const prev = {
    averageRating: entry.averageRating,
    numRatings: entry.numRatings,
    numReviews: entry.numReviews,
    numShelves: entry.numShelves,
  };
  const prevCatalogPages = entry.catalogPages;
  if (result.catalogPages) entry.catalogPages = result.catalogPages;
  // Every successful scrape = "seen recently", so --minAge gates in the other
  // scrapers can skip this author for the cooldown window.
  entry.lastSeen = new Date().toISOString();

  const changed = updateAuthorStats(entry, stats) || entry.catalogPages !== prevCatalogPages;
  if (changed) upsertAuthor(key, entry);

  return { key, name, slug, changed, isNew, stats, prev };
}

export async function runAuthorOne(input: string, options: AuthorOneOptions = {}): Promise<void> {
  const parsed = parseAuthorInput(input);
  if (!parsed) {
    console.error(chalk.red.bold(`Error: could not parse "${input}" as a Goodreads author URL, slug, or ID.`));
    return;
  }

  console.log(chalk.cyan.bold(`\n👤 Author Stats: fetching ${parsed.slug}${options.multiPage ? ' (full catalog crawl)' : ''}`));

  let failReason = 'no_stats_line';
  let result: Awaited<ReturnType<typeof scrapeAuthorStats>>;
  try {
    result = await scrapeAuthorStats(parsed.slug, (r) => { failReason = r; }, !!options.multiPage, undefined, !!options.withCookie);
  } catch (error) {
    // Network went down — nothing to save for this single author.
    if (isConnectivityError(error)) {
      console.error(chalk.red.bold(`   🛑 Network error (${(error as any).code} — ${(error as any).message}) — not recorded as an author failure.`));
      return;
    }
    throw error;
  }
  if (!result) {
    console.log(chalk.yellow(`   ⚠️ No stats line found for ${parsed.slug}`));
    recordAuthorFailure(fallbackNameFromSlug(parsed.slug), failReason);
    return;
  }

  const { key, name, slug, changed, stats, prev } = storeAuthorStats(parsed, result);
  const fmt = (cur?: string, was?: string) =>
    `${cur ?? 'n/a'}${was !== undefined && was !== cur ? chalk.gray(` (prev ${was})`) : ''}`;

  console.log(`   ${chalk.white.bold(name)} (${slug})`);
  console.log(
    `   ${chalk.green.bold(fmt(stats.numRatings, prev.numRatings))} ratings · ` +
    `${chalk.yellow(fmt(stats.numReviews, prev.numReviews))} reviews · ` +
    `${chalk.cyan(fmt(stats.numShelves, prev.numShelves))} shelves · ` +
    `Avg ${fmt(stats.averageRating, prev.averageRating)}`
  );

  if (changed) {
    console.log(chalk.green.bold(`   ✅ Author cache updated (${key})`));
  } else {
    console.log(chalk.gray(`   (No change - values already current or not greater)`));
  }
}

// Batch variant: read author IDs / URLs / slugs one per line and scrape each
// with the same pacing and connectivity handling as author-one. Lines already
// present in the author cache are skipped, so re-running a list only fills the
// misses. Blank lines and # comments are ignored.
export async function runAuthorOneFile(filePath: string, options: AuthorOneOptions = {}): Promise<void> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(chalk.red.bold(`Error: could not read author list file "${filePath}": ${(error as any).message}`));
    return;
  }

  const seen = new Set<string>();
  const todo: { id: string; slug: string }[] = [];
  let unparseable = 0;
  let alreadyPresent = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parsed = parseAuthorInput(trimmed);
    if (!parsed) {
      unparseable++;
      continue;
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    if (authorExistsById(parsed.id)) {
      alreadyPresent++;
      continue;
    }
    todo.push(parsed);
  }

  console.log(chalk.cyan.bold(
    `\n👤 Author batch: scraping ${todo.length} from ${filePath}` +
    `${options.multiPage ? ' (full catalog crawl)' : ''}` +
    ` — ${alreadyPresent} already cached, ${unparseable} unparseable, ${seen.size} unique ids`
  ));

  // Anonymous crawls (no cookie) run at a faster but still polite cadence;
  // GR_AUTHOR_DELAY_MS overrides either profile ("min,max"). This is the gap
  // BETWEEN authors — scrapeAuthorStats only paces pages within one author.
  const [authorDelayMin, authorDelayMax] = parseDelayRange(
    process.env.GR_AUTHOR_DELAY_MS,
    options.withCookie ? 2000 : 1000,
    options.withCookie ? 5000 : 1800,
  );

  let ok = 0;
  let noStats = 0;
  let failed = 0;
  let newAuthors = 0;
  let knownAuthors = 0;
  let newBooks = 0;
  let enrichedBooks = 0;
  for (let i = 0; i < todo.length; i++) {
    const parsed = todo[i];
    const tag = `[${(i + 1).toString().padStart(String(todo.length).length, ' ')}/${todo.length}]`;
    let failReason = 'no_stats_line';
    let result: Awaited<ReturnType<typeof scrapeAuthorStats>>;
    try {
      result = await scrapeAuthorStats(parsed.slug, (r) => { failReason = r; }, !!options.multiPage, undefined, !!options.withCookie);
    } catch (error) {
      // The scrape already ran through the connectivity probe; a blip that
      // exhausted it means the link is down — stop and keep our progress.
      if (isConnectivityError(error)) {
        console.error(chalk.red.bold(`\n${tag} 🛑 Network error (${(error as any).code} — ${(error as any).message}) — stopping batch; progress saved.`));
        break;
      }
      failed++;
      console.error(chalk.red(`${tag} ${parsed.id} ❌ ${(error as any).message}`));
      if (i < todo.length - 1) await delay(authorDelayMin, authorDelayMax);
      continue;
    }
    if (!result) {
      noStats++;
      recordAuthorFailure(fallbackNameFromSlug(parsed.slug), failReason);
      console.log(chalk.yellow(`${tag} ${parsed.id} ⚠️ no stats line`));
    } else {
      const { name, slug, stats, isNew } = storeAuthorStats(parsed, result);
      ok++;
      if (isNew) newAuthors++; else knownAuthors++;
      newBooks += result.booksInserted;
      enrichedBooks += result.booksEnriched;
      const booksNote = result.booksInserted || result.booksEnriched
        ? chalk.gray(` · ${result.booksInserted} new / ${result.booksEnriched} enriched books`)
        : '';
      console.log(`${tag} ${chalk.white.bold(name)} (${slug}) — ${stats.numRatings ?? 'n/a'} ratings · ${stats.numReviews ?? 'n/a'} reviews · ${stats.numShelves ?? 'n/a'} shelves${booksNote}`);
    }
    if (i < todo.length - 1) await delay(authorDelayMin, authorDelayMax);
  }

  const authorBreakdown = ` (${newAuthors} new / ${knownAuthors} already known)`;
  console.log(chalk.cyan.bold(
    `\n🏁 Author batch complete — scraped ${ok}${authorBreakdown}, no-stats ${noStats}, failed ${failed}` +
    `${alreadyPresent ? `, skipped (already cached) ${alreadyPresent}` : ''}.`
  ));
  console.log(chalk.cyan.bold(`   📚 Books: ${newBooks} new / ${enrichedBooks} enriched.`));
}
