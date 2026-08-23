import chalk from 'chalk';
import * as cheerio from 'cheerio';
import readline from 'readline';
import { execSync } from 'child_process';
import { loadBookCache, upsertBook, CachedBook, syncAuthorsToCache } from './storage.js';
import { formatDate } from './utils.js';
import { scrapeBookDetails } from './scraper.js';
import { scrapeAndCacheBook } from './singleBook.js';

export interface ParsedBookData {
  title?: string;
  author?: string;
  authorId?: string;
  avgRating?: string;
  ratings?: string;
  published?: string;
}

export function parseBookFromCopyPasteBuffer(input: string, bookId: string): ParsedBookData {
  const result: ParsedBookData = {};
  if (!input || !input.trim()) return result;

  const trimmed = input.trim();

  // Helper to sanitize ratings count
  const sanitizeRatings = (val: string | number): string | undefined => {
    if (val === undefined || val === null) return undefined;
    const str = String(val).replace(/,/g, '');
    const match = str.match(/\d+/);
    if (match) {
      const num = parseInt(match[0], 10);
      if (!isNaN(num)) return num.toLocaleString('en-US');
    }
    return undefined;
  };

  // Helper to sanitize avg rating
  const sanitizeAvgRating = (val: string | number): string | undefined => {
    if (val === undefined || val === null) return undefined;
    const match = String(val).match(/([0-5]\.\d{1,2})/);
    if (match) {
      const num = parseFloat(match[1]);
      if (!isNaN(num) && num >= 0 && num <= 5) return num.toFixed(2);
    }
    return undefined;
  };

  // Helper to clean author name strings
  const cleanAuthor = (raw: string): string => {
    return raw
      .replace(/^by\s+/i, '')
      .replace(/\s*\((?:Goodreads Author|Contributor|Editor|Translator|Illustrator|Adapter)\)/gi, '')
      .trim();
  };

  // Helper to clean title strings
  const cleanTitle = (raw: string): string => {
    return raw
      .replace(/^\d+[\.\)]\s*/, '') // strip leading line numbers like "1. "
      .trim();
  };

  // 1. Try HTML / Cheerio parsing if input contains HTML tags
  if (/<[a-z][\s\S]*>/i.test(trimmed)) {
    try {
      const $ = cheerio.load(trimmed);

      // 1a. Check Next.js apollo state JSON blob (#__NEXT_DATA__)
      const nextDataJson = $('#__NEXT_DATA__').html();
      if (nextDataJson) {
        try {
          const nextData = JSON.parse(nextDataJson);
          const apolloState = nextData.props?.pageProps?.apolloState || {};

          const bookKey = Object.keys(apolloState).find(k => {
            if (!k.startsWith('Book:')) return false;
            const b = apolloState[k];
            return b && (b.legacyId === parseInt(bookId, 10) || b.legacyId === bookId || String(b.id) === bookId);
          }) || Object.keys(apolloState).find(k => k.startsWith('Book:'));

          if (bookKey && apolloState[bookKey]) {
            const bookData = apolloState[bookKey];
            if (bookData.title || bookData.titleComplete) {
              result.title = bookData.title || bookData.titleComplete;
            }

            let statsObj = null;
            if (bookData.stats?.__ref) statsObj = apolloState[bookData.stats.__ref];
            else if (bookData.stats) statsObj = bookData.stats;
            else if (bookData.work?.__ref && apolloState[bookData.work.__ref]?.stats) {
              const wStats = apolloState[bookData.work.__ref].stats;
              statsObj = wStats.__ref ? apolloState[wStats.__ref] : wStats;
            }

            if (statsObj) {
              if (statsObj.ratingsCount !== undefined) result.ratings = sanitizeRatings(statsObj.ratingsCount);
              if (statsObj.averageRating !== undefined) result.avgRating = sanitizeAvgRating(statsObj.averageRating);
            }

            const contribEdge = bookData.primaryContributorEdge;
            if (contribEdge && contribEdge.node?.__ref) {
              const authorNode = apolloState[contribEdge.node.__ref];
              if (authorNode?.name) result.author = authorNode.name;
              if (authorNode?.id || authorNode?.legacyId) result.authorId = String(authorNode.legacyId || authorNode.id);
            }

            let pubTime: string | undefined;
            if (bookData.work?.__ref && apolloState[bookData.work.__ref]?.details?.publicationTime) {
              pubTime = apolloState[bookData.work.__ref].details.publicationTime;
            } else if (bookData.details?.publicationTime) {
              pubTime = bookData.details.publicationTime;
            }
            if (pubTime) {
              const date = new Date(pubTime);
              if (!isNaN(date.getTime())) {
                result.published = `${date.getFullYear()}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getDate().toString().padStart(2, '0')}`;
              }
            }
          }
        } catch (e) {}
      }

      // 1b. Check JSON-LD
      if (!result.title || !result.author) {
        $('script[type="application/ld+json"]').each((_, elem) => {
          try {
            const ldJson = JSON.parse($(elem).html() || '');
            if (ldJson['@type'] === 'Book' || ldJson.name) {
              if (!result.title && ldJson.name) result.title = ldJson.name;
              if (!result.author && ldJson.author) {
                if (typeof ldJson.author === 'string') result.author = ldJson.author;
                else if (Array.isArray(ldJson.author) && ldJson.author[0]?.name) result.author = ldJson.author[0].name;
                else if (ldJson.author?.name) result.author = ldJson.author.name;
              }
              if (!result.avgRating && ldJson.aggregateRating?.ratingValue) {
                result.avgRating = sanitizeAvgRating(ldJson.aggregateRating.ratingValue);
              }
              if (!result.ratings && ldJson.aggregateRating?.ratingCount) {
                result.ratings = sanitizeRatings(ldJson.aggregateRating.ratingCount);
              }
              if (!result.published && ldJson.datePublished) {
                result.published = formatDate(String(ldJson.datePublished));
              }
            }
          } catch (e) {}
        });
      }

      // 1c. DOM selectors
      if (!result.title) {
        const titleText = $('h1[data-testid="bookTitle"], #bookTitle, h1.bookTitle, h1.Text__title1, .BookPageTitleSection__title h1').first().text().trim();
        if (titleText) result.title = titleText;
      }
      if (!result.author) {
        const authorText = $('span[data-testid="name"], a.authorName, [data-testid="authorName"], .ContributorLink__name, .authorName span').first().text().trim();
        if (authorText) result.author = authorText;
      }
      if (!result.authorId) {
        const authorHref = $('a[href*="/author/show/"]').first().attr('href');
        if (authorHref) {
          const match = authorHref.match(/\/author\/show\/(\d+)/);
          if (match) result.authorId = match[1];
        }
      }
      if (!result.avgRating) {
        const avgText = $('div.RatingStatistics__rating, [data-testid="averageRating"], span[itemprop="ratingValue"], .RatingStatistics__rating span').first().text().trim();
        if (avgText) result.avgRating = sanitizeAvgRating(avgText);
      }
      if (!result.ratings) {
        const ratingsText = $('span[data-testid="ratingsCount"], span[itemprop="ratingCount"], [data-testid="ratingsCount"]').first().text().trim();
        if (ratingsText) result.ratings = sanitizeRatings(ratingsText);
      }
      if (!result.published) {
        const pubText = $('p[data-testid="publicationInfo"], div.row:contains("Published"), .PublicationInfo').first().text().trim();
        if (pubText) result.published = formatDate(pubText);
      }
    } catch (e) {}
  }

  // 2. Try JSON parsing if input resembles JSON
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj.title || obj.name || obj.bookTitle) result.title = result.title || obj.title || obj.name || obj.bookTitle;
      if (obj.author || obj.authorName || obj.by) result.author = result.author || obj.author || obj.authorName || obj.by;
      if (obj.authorId || obj.author_id) result.authorId = result.authorId || String(obj.authorId || obj.author_id);
      if (obj.avgRating || obj.averageRating || obj.rating) result.avgRating = result.avgRating || sanitizeAvgRating(obj.avgRating || obj.averageRating || obj.rating);
      if (obj.ratings || obj.ratingsCount || obj.numRatings || obj.votes) result.ratings = result.ratings || sanitizeRatings(obj.ratings || obj.ratingsCount || obj.numRatings || obj.votes);
      if (obj.published || obj.publicationDate || obj.publishedDate || obj.year) result.published = result.published || formatDate(String(obj.published || obj.publicationDate || obj.publishedDate || obj.year));
    } catch (e) {}
  }

  // 3. Key-Value Regex Matching
  const titleKV = trimmed.match(/^\s*(?:Title|Book Title|Name)\s*:\s*(.+)$/im);
  if (!result.title && titleKV) result.title = cleanTitle(titleKV[1]);

  const authorKV = trimmed.match(/^\s*(?:Author|Book Author|Writer|By)\s*:\s*(.+)$/im);
  if (!result.author && authorKV) result.author = cleanAuthor(authorKV[1]);

  const authorIdKV = trimmed.match(/^\s*(?:Author ID|AuthorId)\s*:\s*(\d+)$/im);
  if (!result.authorId && authorIdKV) result.authorId = authorIdKV[1].trim();

  const avgKV = trimmed.match(/^\s*(?:Avg Rating|Average Rating|Rating|Score)\s*:\s*([0-5]\.\d{1,2})/im);
  if (!result.avgRating && avgKV) result.avgRating = sanitizeAvgRating(avgKV[1]);

  const ratingsKV = trimmed.match(/^\s*(?:Ratings|Rating Count|Total Ratings|Votes)\s*:\s*([\d,]+)/im);
  if (!result.ratings && ratingsKV) result.ratings = sanitizeRatings(ratingsKV[1]);

  const pubKV = trimmed.match(/^\s*(?:Published|Publication Date|Pub Date|Year)\s*:\s*(.+)$/im);
  if (!result.published && pubKV) result.published = formatDate(pubKV[1].trim());

  // 4. Extract Avg Rating & Ratings count from anywhere in the text
  if (!result.avgRating) {
    const avgMatch = trimmed.match(/(?:avg rating|average rating|rating:?)\s*([0-5]\.\d{1,2})|([0-5]\.\d{1,2})\s*(?:avg rating|average rating|rating|\d+\s*ratings|\d+\s*reviews)?/i);
    if (avgMatch) {
      result.avgRating = sanitizeAvgRating(avgMatch[1] || avgMatch[2]);
    }
  }

  if (!result.ratings) {
    const ratMatch = trimmed.match(/([\d,]+)\s*ratings/i);
    if (ratMatch) {
      result.ratings = sanitizeRatings(ratMatch[1]);
    }
  }

  if (!result.published) {
    const pubMatch = trimmed.match(/(?:first published|published|publication date)\s*(?:in|on)?\s*([A-Za-z]+\s+\d{1,2},?\s*\d{4}|\d{4}\.\d{2}\.\d{2}|\d{4})/i);
    if (pubMatch) {
      result.published = formatDate(pubMatch[1]);
    }
  }

  // 5. Header cut-off & Title/Author extraction from copied text
  if (!result.title || !result.author) {
    const boundaryRegex = /(?:\b[0-5]\.\d{1,2}\b|\b[\d,]+\s*ratings\b|Edit book details|Want to read|Currently reading|Read\b|Rate this book|Book details & editions)/i;
    const matchBoundary = trimmed.match(boundaryRegex);

    let headerText = trimmed;
    if (matchBoundary && matchBoundary.index !== undefined && matchBoundary.index > 0) {
      headerText = trimmed.slice(0, matchBoundary.index).trim();
    }

    const byIndex = headerText.search(/\s+by\s+/i);
    if (byIndex !== -1) {
      const rawTitle = headerText.slice(0, byIndex).trim();
      const rawAuthor = headerText.slice(byIndex + 4).trim();
      if (!result.title && rawTitle) result.title = cleanTitle(rawTitle);
      if (!result.author && rawAuthor) result.author = cleanAuthor(rawAuthor);
    } else {
      const parts = headerText.split(/\n+|\t+| {2,}/).map(p => p.trim()).filter(p => p.length > 0);
      
      if (parts.length >= 2) {
        if (!result.title) result.title = cleanTitle(parts[0]);
        if (!result.author) result.author = cleanAuthor(parts[1]);
      } else if (parts.length === 1) {
        const single = parts[0];
        const words = single.split(/\s+/);
        if (words.length >= 3) {
          const authorCandidate = words.slice(-2).join(' ');
          const titleCandidate = words.slice(0, -2).join(' ');
          if (!result.title) result.title = cleanTitle(titleCandidate);
          if (!result.author) result.author = cleanAuthor(authorCandidate);
        } else if (!result.title) {
          result.title = cleanTitle(single);
        }
      }
    }
  }

  if (!result.published) {
    const yearMatch = trimmed.match(/\b(19\d\d|20\d\d)\b/);
    if (yearMatch) {
      result.published = yearMatch[1];
    }
  }

  return result;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function readInteractiveInput(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    const lines: string[] = [];
    rl.on('line', (line) => {
      if (line.trim() === '' && lines.length > 0) {
        rl.close();
      } else {
        lines.push(line);
      }
    });
    rl.on('close', () => {
      resolve(lines.join('\n').trim());
    });
  });
}

export async function addBookFromBuffer(bookIdOrUrl: string, rawInputArg?: string, options: any = {}) {
  // Support numeric ID or full URL e.g. https://www.goodreads.com/book/show/23625605
  const urlMatch = bookIdOrUrl.match(/\/book\/show\/(\d+)/);
  const bookId = urlMatch ? urlMatch[1] : bookIdOrUrl.trim().replace(/[^\d]/g, '');

  if (!bookId) {
    console.error(chalk.red.bold('Error: Invalid Book ID or Goodreads URL provided.'));
    return null;
  }

  const bookCache = await loadBookCache();
  const existing = bookCache[bookId];

  let rawBuffer = rawInputArg || '';

  // 1. If rawInputArg is empty and stdin is piped, read stdin
  if (!rawBuffer && !process.stdin.isTTY) {
    rawBuffer = await readStdin();
  }

  // 2. If no copy-paste buffer was provided, attempt online lookup first using logged-in credentials
  if (!rawBuffer && !options.title && !options.author) {
    console.log(chalk.cyan(`🌐 Attempting online lookup for book ID ${bookId} using logged-in credentials...`));
    const onlineResult = await scrapeBookDetails(bookId, existing?.title, existing?.author, existing?.authorId);
    
    if (onlineResult && !onlineResult.isFailed && onlineResult.title && onlineResult.title !== 'Unknown') {
      console.log(chalk.green(`   ✅ Online lookup succeeded directly via Goodreads!`));
      return await scrapeAndCacheBook(bookId, true, bookCache);
    } else {
      console.log(chalk.yellow(`   ⚠️ Online HTTP lookup required fallback. Checking system clipboard...`));
    }
  }

  // 3. If rawBuffer is empty, attempt to read from system clipboard (pbpaste)
  if (!rawBuffer) {
    try {
      const clipboardText = execSync('pbpaste', { encoding: 'utf8' }).trim();
      if (clipboardText) {
        console.log(chalk.cyan('📋 Detected content in system copy-paste buffer (clipboard).'));
        const preview = clipboardText.length > 200 ? clipboardText.slice(0, 200) + '...' : clipboardText;
        console.log(chalk.gray(`   Preview: "${preview.replace(/\n/g, ' ')}"\n`));
        rawBuffer = clipboardText;
      }
    } catch (e) {
      // pbpaste not available or empty
    }
  }

  // 4. Parse buffer
  let parsed = parseBookFromCopyPasteBuffer(rawBuffer, bookId);

  // Apply explicit command-line option overrides if provided
  if (options.title) parsed.title = options.title;
  if (options.author) parsed.author = options.author;
  if (options.ratings) parsed.ratings = options.ratings;
  if (options.avg) parsed.avgRating = options.avg;
  if (options.published) parsed.published = formatDate(options.published);

  // 5. If critical fields are missing and terminal is interactive, prompt for input
  if (process.stdin.isTTY && (!parsed.title || !parsed.author)) {
    console.log(chalk.yellow(`⚠️  Could not automatically parse title/author from copy-paste buffer.`));
    console.log(chalk.cyan(`Please paste your book info or HTML below, then press ENTER twice:`));
    const interactiveText = await readInteractiveInput();
    if (interactiveText) {
      const interactiveParsed = parseBookFromCopyPasteBuffer(interactiveText, bookId);
      parsed = {
        title: parsed.title || interactiveParsed.title,
        author: parsed.author || interactiveParsed.author,
        authorId: parsed.authorId || interactiveParsed.authorId,
        avgRating: parsed.avgRating || interactiveParsed.avgRating,
        ratings: parsed.ratings || interactiveParsed.ratings,
        published: parsed.published || interactiveParsed.published
      };
    }
  }

  // Final values merging with existing cached book data if available
  const finalTitle = parsed.title || existing?.title || `Book [ID: ${bookId}]`;
  const finalAuthor = parsed.author || existing?.author || 'Unknown Author';
  const finalAuthorId = parsed.authorId || existing?.authorId;
  const finalRatings = parsed.ratings || existing?.ratings || '0';
  const finalAvgRating = parsed.avgRating || existing?.avgRating;
  const finalPublished = parsed.published ? formatDate(parsed.published) : (existing?.published || 'Unknown');

  const updatedBook: CachedBook = {
    id: bookId,
    title: finalTitle,
    author: finalAuthor,
    authorId: finalAuthorId,
    ratings: finalRatings,
    avgRating: finalAvgRating,
    published: finalPublished,
    pages: existing?.pages,
    seriesPos: existing?.seriesPos,
    lastUpdated: new Date().toISOString(),
    tags: existing?.tags || {},
    genres: existing?.genres,
    requiresAuth: existing?.requiresAuth || false,
    isBad: false,
    failCount: 0
  };

  bookCache[bookId] = updatedBook;
  upsertBook(updatedBook);

  // Sync author cache if author details exist
  if (finalAuthor && finalAuthor !== 'Unknown Author') {
    syncAuthorsToCache([{ author: finalAuthor, authorId: finalAuthorId, authorSlug: finalAuthorId ? `${finalAuthorId}.${finalAuthor.replace(/\s+/g, '_')}` : undefined }], {});
  }

  console.log(chalk.green.bold(`\n✅ Book ${bookId} successfully saved to booksCache.json!`));
  console.log(chalk.cyan(`   ID:          ${updatedBook.id}`));
  console.log(chalk.cyan(`   Title:       ${updatedBook.title}`));
  console.log(chalk.cyan(`   Author:      ${updatedBook.author}${updatedBook.authorId ? ` (ID: ${updatedBook.authorId})` : ''}`));
  console.log(chalk.cyan(`   Avg Rating:  ${updatedBook.avgRating || 'None'}`));
  console.log(chalk.cyan(`   Ratings:     ${updatedBook.ratings}`));
  console.log(chalk.cyan(`   Published:   ${updatedBook.published}`));

  return updatedBook;
}
