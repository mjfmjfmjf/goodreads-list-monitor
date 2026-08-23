import chalk from 'chalk';
import { findAuthorBySlug, upsertAuthor, updateAuthorStats } from './storage.js';
import type { AuthorCacheEntry } from './storage.js';
import { scrapeAuthorStats } from './scraper.js';

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

export async function runAuthorOne(input: string): Promise<void> {
  const parsed = parseAuthorInput(input);
  if (!parsed) {
    console.error(chalk.red.bold(`Error: could not parse "${input}" as a Goodreads author URL, slug, or ID.`));
    return;
  }

  console.log(chalk.cyan.bold(`\n👤 Author Stats: fetching ${parsed.slug}`));

  const result = await scrapeAuthorStats(parsed.slug);
  if (!result) {
    console.log(chalk.yellow(`   ⚠️ No stats line found for ${parsed.slug}`));
    return;
  }
  const stats = result.stats;

  const slug = stats.slug || parsed.slug;
  const id = slug.split('.')[0];
  const name = stats.name || fallbackNameFromSlug(slug);

  const found = findAuthorBySlug(slug);
  const key = found?.key ?? name;
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

  const changed = updateAuthorStats(entry, stats);
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
    upsertAuthor(key, entry);
    console.log(chalk.green.bold(`   ✅ Author cache updated (${key})`));
  } else {
    console.log(chalk.gray(`   (No change - values already current or not greater)`));
  }
}
