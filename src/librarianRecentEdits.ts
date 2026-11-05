import chalk from 'chalk';
import { loadConfig } from './storage.ts';
import { getBook, upsertBook, getAuthorById, upsertAuthorById, upsertAuthorSlug, authorExistsById } from './storage.ts';
import type { CachedBook, AuthorCacheEntry } from './storage.ts';
import https from 'https';
import { parseDelayRange } from './utils.ts';

const RECENT_EDITS_URL = 'https://www.goodreads.com/librarian/recent_edits';

export interface LibrarianRecentEditsOptions {
  pages?: number;
  dryRun?: boolean;
  delayMs?: number;
}

export interface LibrarianRecentEditsSummary {
  pagesFetched: number;
  bookLinksSeen: number;
  authorLinksSeen: number;
  uniqueBookIds: number;
  uniqueAuthorIds: number;
  newBooksInserted: number;
  newAuthorsInserted: number;
  booksSkippedExisting: number;
  booksSkippedSeenThisRun: number;
  authorsSkippedExisting: number;
  authorsSkippedSeenThisRun: number;
  elapsedMs: number;
}

interface ParsedBook {
  bookId: string;
  title?: string;
  author?: string;
  authorId?: string;
}

interface ParsedAuthor {
  authorId: string;
  slug?: string;
  name?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function fetchPage(page: number, cookie: string): Promise<{ status: number; body: string; duration: number; size: number }> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.goodreads.com',
      path: `/librarian/recent_edits?page=${page}`,
      method: 'GET',
      headers: {
        'Cookie': cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        const duration = (Date.now() - start) / 1000;
        resolve({ status: res.statusCode || 0, body: data, duration, size: data.length });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

function extractBookLinks(html: string): Array<{ bookId: string; title?: string; href: string }> {
  const results: Array<{ bookId: string; title?: string; href: string }> = [];
  // Match book/show links with optional title in anchor text
  const re = /<a[^>]+href=["']\/book\/show\/([0-9]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const bookId = m[1];
    let title: string | undefined = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // Decode basic entities
    title = title.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
    if (!title) title = undefined;
    results.push({ bookId, title, href: m[0] });
  }
  return results;
}

function extractAuthorLinks(html: string): Array<{ authorId: string; slug?: string; name?: string; href: string }> {
  const results: Array<{ authorId: string; slug?: string; name?: string; href: string }> = [];
  const re = /<a[^>]+href=["']\/author\/show\/([0-9]+)(?:\.([^"?#/]+))?[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const authorId = m[1];
    const slugPart = m[2];
    let name: string | undefined = m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    name = name.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ');
    if (!name) name = undefined;
    results.push({ authorId, slug: slugPart ? `${authorId}.${slugPart}` : authorId, name, href: m[0] });
  }
  return results;
}

// Try to associate authors with books by looking for "by <author>" patterns near book links
function associateBooksWithAuthors(html: string, bookLinks: Array<{ bookId: string; title?: string }>, authorLinks: Array<{ authorId: string; slug?: string; name?: string }>): ParsedBook[] {
  const books: ParsedBook[] = [];
  // Build a map of author names/ids for quick lookup
  const authorById = new Map<string, ParsedAuthor>();
  for (const a of authorLinks) {
    authorById.set(a.authorId, { authorId: a.authorId, slug: a.slug, name: a.name });
  }

  // For each book link, search backwards and forwards a bit for "by" followed by author
  for (const bl of bookLinks) {
    let authorId: string | undefined;
    let authorName: string | undefined;
    // Look for pattern: by <a href="/author/show/ID...">Name</a> near this book
    const bookIdEsc = bl.bookId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Search in a window around the book link
    const idx = html.indexOf(`/book/show/${bl.bookId}`);
    if (idx >= 0) {
      const start = Math.max(0, idx - 500);
      const end = Math.min(html.length, idx + 500);
      const window = html.slice(start, end);
      const byRe = /by\s+<a[^>]+href=["']\/author\/show\/([0-9]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i;
      const byMatch = window.match(byRe);
      if (byMatch) {
        authorId = byMatch[1];
        authorName = byMatch[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        authorName = authorName.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
      }
    }
    books.push({
      bookId: bl.bookId,
      title: bl.title,
      author: authorName || (authorId ? authorById.get(authorId)?.name : undefined) || undefined,
      authorId,
    });
  }
  return books;
}

export async function runLibrarianRecentEdits(options: LibrarianRecentEditsOptions = {}): Promise<LibrarianRecentEditsSummary> {
  const maxPages = Math.max(1, Math.min(100, options.pages ?? 100));
  const dryRun = !!options.dryRun;
  const [delayMin, delayMax] = parseDelayRange(process.env.LIBRARIAN_RECENT_EDITS_DELAY_MS, 1000, 2000);
  const delayMs = options.delayMs;

  console.log(chalk.cyan.bold(`\n📚 librarian-recent-edits: fetching up to ${maxPages} pages from ${RECENT_EDITS_URL}`));
  console.log(chalk.yellow.bold('   ⚠️  REQUIRES CREDENTIALS (loadConfig().cookie) - will redirect without auth'));
  if (dryRun) {
    console.log(chalk.gray('   DRY RUN — enumerate only, no writes'));
  }

  const start = Date.now();
  const summary: LibrarianRecentEditsSummary = {
    pagesFetched: 0,
    bookLinksSeen: 0,
    authorLinksSeen: 0,
    uniqueBookIds: 0,
    uniqueAuthorIds: 0,
    newBooksInserted: 0,
    newAuthorsInserted: 0,
    booksSkippedExisting: 0,
    booksSkippedSeenThisRun: 0,
    authorsSkippedExisting: 0,
    authorsSkippedSeenThisRun: 0,
    elapsedMs: 0,
  };

  const config = loadConfig();
  const cookie = config.cookie || '';
  if (!cookie) {
    console.log(chalk.red.bold('   No cookie found in config.json - this will fail. Add cookies from a logged-in session.'));
  }

  const seenBookIds = new Set<string>();
  const seenAuthorIds = new Set<string>();

  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    console.log(chalk.gray(`🌐 Scraping recent edits page ${pageNum}...`));
    let result: { status: number; body: string; duration: number; size: number };
    try {
      result = await fetchPage(pageNum, cookie);
    } catch (err: any) {
      const waitMs = 10000 + Math.floor(Math.random() * 6000);
      console.log(chalk.yellow(`   ✗ page=${pageNum} error: ${err.message} - waiting ${(waitMs / 1000).toFixed(1)}s and skipping to next page...`));
      await sleep(waitMs);
      if (pageNum < maxPages) {
        const pMs = delayMs !== undefined ? delayMs : (delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1)));
        console.log(chalk.gray(`   (Waiting ${(pMs / 1000).toFixed(2)}s before page ${pageNum + 1}...)`));
        await sleep(pMs);
      }
      continue;
    }

    const sizeKb = (result.size / 1024).toFixed(1);
    if (result.status === 500) {
      const waitMs = 10000 + Math.floor(Math.random() * 6000);
      console.log(chalk.yellow(`   [err] page=${pageNum} http=${result.status} dur=${result.duration.toFixed(3)}s size=${sizeKb}KB - waiting ${(waitMs / 1000).toFixed(1)}s and skipping to next page...`));
      await sleep(waitMs);
      if (pageNum < maxPages) {
        const pMs = delayMs !== undefined ? delayMs : (delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1)));
        console.log(chalk.gray(`   (Waiting ${(pMs / 1000).toFixed(2)}s before page ${pageNum + 1}...)`));
        await sleep(pMs);
      }
      continue;
    }
    if (result.status === 302 || result.status === 301) {
      console.log(chalk.red.bold(`   [err] page=${pageNum} http=${result.status} dur=${result.duration.toFixed(3)}s size=${sizeKb}KB (redirected, auth required) - stopping`));
      break;
    }
    if (result.status !== 200) {
      console.log(chalk.yellow(`   [err] page=${pageNum} http=${result.status} dur=${result.duration.toFixed(3)}s size=${sizeKb}KB - stopping`));
      break;
    }

    const bookLinks = extractBookLinks(result.body);
    const authorLinks = extractAuthorLinks(result.body);
    
    if (bookLinks.length === 0 && authorLinks.length === 0) {
      console.log(chalk.yellow(`   [warn] page=${pageNum} http=${result.status} dur=${result.duration.toFixed(3)}s size=${sizeKb}KB — no book/author links found - stopping`));
      break;
    }

    summary.pagesFetched++;
    summary.bookLinksSeen += bookLinks.length;
    summary.authorLinksSeen += authorLinks.length;

    const newBooksThisPage: Array<{ bookId: string; title?: string }> = [];
    const newAuthorsThisPage: Array<{ authorId: string; slug?: string; name?: string }> = [];

    for (const bl of bookLinks) {
      if (!seenBookIds.has(bl.bookId)) {
        seenBookIds.add(bl.bookId);
        newBooksThisPage.push(bl);
      } else {
        summary.booksSkippedSeenThisRun++;
      }
    }
    for (const al of authorLinks) {
      if (!seenAuthorIds.has(al.authorId)) {
        seenAuthorIds.add(al.authorId);
        newAuthorsThisPage.push(al);
      } else {
        summary.authorsSkippedSeenThisRun++;
      }
    }

    console.log(chalk.green(`   [ok] page=${pageNum} http=${result.status} dur=${result.duration.toFixed(3)}s size=${sizeKb}KB → ${bookLinks.length} book links, ${authorLinks.length} author links (${seenBookIds.size} unique books, ${seenAuthorIds.size} unique authors)`));

    if (!dryRun) {
      // Insert new authors first (simple row capture only, no back-catalog scrape)
      for (const al of newAuthorsThisPage) {
        if (authorExistsById(al.authorId) || getAuthorById(al.authorId)) {
          summary.authorsSkippedExisting++;
          continue;
        }
        const slug = al.slug || al.authorId;
        const name = al.name || slug;
        const finalSlug = slug || al.authorId;
        const finalName = name || finalSlug;
    const entry = {
      id: al.authorId,
      name: finalName,
      slug: finalSlug,
      lastSeen: new Date().toISOString(),
      firstSeen: new Date().toISOString(),
      source: 'librarian_recent_edits',
    } as AuthorCacheEntry;
        try {
          upsertAuthorById(al.authorId, entry);
          upsertAuthorSlug(al.authorId, finalSlug, finalName);
          summary.newAuthorsInserted++;
        } catch (e: any) {
          // continue on error
        }
      }
      // Insert new books (minimal insert only if unseen)
      for (const bl of newBooksThisPage) {
        if (getBook(bl.bookId)) {
          summary.booksSkippedExisting++;
          continue;
        }
        const entry = {
          id: bl.bookId,
          title: bl.title || 'Unknown',
          author: 'Unknown',
          authorId: undefined,
          ratings: '0',
          published: 'Unknown',
          lastUpdated: new Date().toISOString(),
          firstSeen: new Date().toISOString(),
        } as any as CachedBook;
        try {
          upsertBook(entry);
          summary.newBooksInserted++;
        } catch (e: any) {
          // continue on error
        }
      }
      if (newAuthorsThisPage.length > 0 || newBooksThisPage.length > 0) {
        console.log(chalk.gray(`     ↳ inserted ${newAuthorsThisPage.length > 0 ? summary.newAuthorsInserted - (summary.newAuthorsInserted - newAuthorsThisPage.filter(a=>!(authorExistsById(a.authorId)||getAuthorById(a.authorId))&&!dryRun).length >=0 ? 0:0) : 0} new authors this page context; +${newBooksThisPage.filter(b=>!getBook(b.bookId)).length} books checked`));
      }
    }

    if (pageNum < maxPages) {
      const pMs = delayMs !== undefined ? delayMs : (delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1)));
      console.log(chalk.gray(`   (Waiting ${(pMs / 1000).toFixed(2)}s...)`));
      await sleep(pMs);
    }
  }

  summary.uniqueBookIds = seenBookIds.size;
  summary.uniqueAuthorIds = seenAuthorIds.size;

  if (dryRun) {
    console.log(chalk.cyan.bold(`\n   DRY RUN: ${summary.uniqueBookIds} unique books, ${summary.uniqueAuthorIds} unique authors across ${summary.pagesFetched} pages`));
    if (summary.booksSkippedSeenThisRun > 0 || summary.authorsSkippedSeenThisRun > 0) {
      console.log(chalk.gray(`   (skipped ${summary.booksSkippedSeenThisRun} duplicate book links, ${summary.authorsSkippedSeenThisRun} duplicate author links this run)`));
    }
    summary.elapsedMs = Date.now() - start;
    console.log(chalk.cyan.bold(`\n   Done in ${fmt(summary.elapsedMs)}.`));
    return summary;
  }

  if (summary.booksSkippedSeenThisRun > 0 || summary.authorsSkippedSeenThisRun > 0) {
    console.log(chalk.gray(`   (skipped ${summary.booksSkippedSeenThisRun} duplicate book links, ${summary.authorsSkippedSeenThisRun} duplicate author links across pages)`));
  }

  summary.elapsedMs = Date.now() - start;
  console.log(chalk.cyan.bold(
    `\n   Done: ${summary.pagesFetched} pages, ${summary.uniqueBookIds} unique books (${summary.newBooksInserted} new), ${summary.uniqueAuthorIds} unique authors (${summary.newAuthorsInserted} new) in ${fmt(summary.elapsedMs)}.`
  ));
  return summary;
}
