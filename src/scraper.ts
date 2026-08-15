import * as cheerio from 'cheerio';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'fs-extra';
import path from 'path';
import { delay, fetchWithRetry, formatDate } from './utils.js';
import { loadConfig, loadAuthorCache, syncAuthorsToCache, saveAuthorCache, updateAuthorStats } from './storage.js';
import type { AuthorCache, AuthorCacheEntry, AuthorStats } from './storage.js';

let structuralWarningIssued = false;

async function handleStructuralWarning(message: string) {
  if (structuralWarningIssued) {
    console.log(chalk.yellow(`   ⚠️ ${message}`));
    return;
  }
  structuralWarningIssued = true;

  console.log('\n' + chalk.bgRed.white.bold(' 🛑 CRITICAL SITE STRUCTURE WARNING '));
  console.log(chalk.red.bold(`   ${message}`));
  console.log(chalk.yellow('\n   Goodreads may have changed its page format. Continuing may result in incorrect data being cached.'));
  
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(chalk.cyan.bold('   Press ENTER to continue anyway, or "q" then ENTER to quit: '));
    if (answer.toLowerCase() === 'q') {
      console.log(chalk.red.bold('\n   🛑 Aborting run due to site structure concerns.'));
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

export interface ListMetadata {
  id: string;
  title: string;
  bookCount: number;
  discoveryPage: number;
  url: string;
}

export interface BookMetadata {
  id: string;
  title: string;
  author: string;
  authorId?: string;
  authorSlug?: string; // e.g. "1077326.J_K_Rowling"
  position: number;
  ratings: string;
  avgRating?: string;
  published: string;
  pages?: string;
  tagCount?: number;
  page?: number;
  requiresAuth?: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TIMEOUT = 30000; // 30 seconds

export async function scrapeAllUserLists(userId: string): Promise<ListMetadata[]> {
  const configData = await loadConfig();
  let allLists: ListMetadata[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    console.log(chalk.cyan.bold(`🌐 Scraping discovery page ${page}...`));
    const url = `https://www.goodreads.com/list/created/${userId}?page=${page}`;
    
    try {
      const headers: any = { 'User-Agent': USER_AGENT };
      if (configData.cookie) headers['Cookie'] = configData.cookie;

      const response = await fetchWithRetry(url, {
        headers,
        timeout: TIMEOUT
      });

      const $ = cheerio.load(response.data);
      const pageLists: ListMetadata[] = [];

      $('.listTitle').each((_, element) => {
        const $a = $(element);
        const title = $a.text().trim();
        const href = $a.attr('href') || '';
        const match = href.match(/\/list\/show\/(\d+)\./);
        const id = match ? match[1] : '';

        if (id) {
          const detailsText = $a.nextAll('.listFullDetails').first().text().trim();
          const countMatch = detailsText.match(/([\d,]+) books/);
          const bookCount = countMatch ? parseInt(countMatch[1].replace(/,/g, ''), 10) : 0;
          const fullUrl = `https://www.goodreads.com${href.split('?')[0]}`;
          pageLists.push({ id, title, bookCount, discoveryPage: page, url: fullUrl });
        }
      });

      allLists = allLists.concat(pageLists);

      const nextBtn = $('.next_page');
      if (nextBtn.length > 0 && !nextBtn.hasClass('disabled') && pageLists.length > 0) {
        page++;
        await delay();
      } else {
        hasNext = false;
      }
    } catch (error) {
      console.error(chalk.red.bold(`   ❌ Fatal error fetching discovery page ${page}:`), (error as any).message);
      throw error;
    }
  }

  return allLists;
}

export async function scrapeTopShelves(): Promise<string[]> {
  const configData = await loadConfig();
  const url = 'https://www.goodreads.com/shelf';
  const headers: any = { 'User-Agent': USER_AGENT };
  if (configData.cookie) headers['Cookie'] = configData.cookie;

  const response = await fetchWithRetry(url, { headers, timeout: TIMEOUT });
  const $ = cheerio.load(response.data);

  const tags: string[] = [];
  $('a[href*="/shelf/show/"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const match = href.match(/\/shelf\/show\/([^?#]+)/);
    if (match) {
      const tag = decodeURIComponent(match[1].trim());
      if (tag && !tags.includes(tag)) {
        tags.push(tag);
      }
    }
  });

  return tags;
}

export async function scrapeShelfBooks(tag: string, minTags = 0, maxPages = 25): Promise<BookMetadata[]> {
  const configData = await loadConfig();
  let allBooks: BookMetadata[] = [];
  let thresholdReached = false;
  let lastPageFirstId = '';

  for (let page = 1; page <= maxPages; page++) {
    if (thresholdReached) break;

    console.log(chalk.cyan.bold(`🌐 Scraping shelf "${tag}" page ${page}...`));
    const url = `https://www.goodreads.com/shelf/show/${tag}?page=${page}`;
    
    try {
      const axiosConfig: any = {
        headers: { 
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Referer': `https://www.goodreads.com/shelf/show/${tag}${page > 1 ? `?page=${page - 1}` : ''}`
        },
        timeout: TIMEOUT
      };

      if (configData.cookie) {
        axiosConfig.headers['Cookie'] = configData.cookie;
      }

      const response = await fetchWithRetry(url, axiosConfig);
      const $ = cheerio.load(response.data);
      const pageBooks: BookMetadata[] = [];
      const items = $('.elementList');

      if (items.length === 0) {
        console.log(chalk.gray(`   (No more books found on shelf. Stopping at page ${page}.)`));
        break;
      }

      let firstIdOnThisPage = '';

      items.each((i, element) => {
        if (thresholdReached) return;

        const $el = $(element);
        const $title = $el.find('.bookTitle');
        const title = $title.find('span[itemprop="name"]').text().trim() || $title.text().trim();
        const href = $title.attr('href') || '';
        const match = href.match(/\/book\/show\/(\d+)/);
        const id = match ? match[1] : '';

        if (id) {
          if (i === 0) firstIdOnThisPage = id;

          const $authorA = $el.find('.authorName');
          const author = $authorA.text().trim() || 'Unknown Author';
          const authorHref = $authorA.attr('href') || '';
          const authorMatch = authorHref.match(/\/author\/show\/([^?#\s/]+)/);
          const authorSlug = authorMatch ? authorMatch[1] : undefined;
          const authorId = authorSlug ? authorSlug.split('.')[0] : undefined;

          const metaText = $el.find('.greyText.smallText').text().trim();
          
          const ratingsMatch = metaText.match(/([\d,]+) rating/);
          const ratings = ratingsMatch ? ratingsMatch[1] : '0';

// mjf 
//console.log(`metaText=${metaText}`);

// list         const avgRatingMatch = metaText.match(/(\d\.\d{2}) avg rating/);
//          const avgRating = avgRatingMatch ? avgRatingMatch[1] : undefined;

// tag const avgRatingMatch = metaText.match(/avg rating (\d\.\d{2})/);
// const avgRating = avgRatingMatch ? avgRatingMatch[1] : undefined;

//const regexRating = /(?:avg rating (\d\.\d{2}))|(?:(\d\.\d{2}) avg rating)/;
//const avgRating = match ? (regexRating[1] || regexRating[2]) : undefined;

// Matches a decimal number that is either right after or right before "avg rating"
const regexRating = /(?:avg rating\s+(\d\.\d{2}))|(?:(\d\.\d{2})\s+avg rating)/;
const match = metaText.match(regexRating);

// Still requires the OR check because of the two capture groups
const avgRating = match ? (match[1] || match[2]) : undefined;

          const yearMatch = metaText.match(/(?:published|publication).*?(\d{4})/i) || metaText.match(/\b(?:18|19|20)\d{2}\b/);
          const published = yearMatch ? (yearMatch[1] || yearMatch[0]) : 'Unknown';

          const fullText = $el.text().replace(/\s+/g, ' ');
          const tagMatch = fullText.match(/shelved ([\d,]+) times/i);
          const tagCount = tagMatch ? parseInt(tagMatch[1].replace(/,/g, ''), 10) : null;

          if (i === 0 || i === items.length - 1) {
            console.log(chalk.gray(`      [${i === 0 ? 'Top' : 'Bottom'}] "${title.substring(0, 30)}..." has ${tagCount ?? '??'} tags.`));
          }

          if (minTags > 0 && tagCount !== null && tagCount < minTags) {
            console.log(chalk.yellow.bold(`   🛑 Threshold reached at book "${title}": ${tagCount} tags < ${minTags}.`));
            thresholdReached = true;
            return;
          }

          pageBooks.push({ id, title, author, authorId, authorSlug, position: 0, ratings, avgRating, published, tagCount: tagCount ?? 0 });
        }
      });

      if (page > 1 && firstIdOnThisPage === lastPageFirstId) {
        console.log(chalk.red.bold(`   ⚠️ Warning: Goodreads is returning Page 1 content for Page ${page}.`));
        console.log(chalk.red.bold(`   (Ensure your config.json cookie is fresh and valid.)`));
        break;
      }
      lastPageFirstId = firstIdOnThisPage;

      allBooks = allBooks.concat(pageBooks);

      if (!thresholdReached && page < maxPages) {
        const waitMin = configData.cookie ? 4000 : 2000;
        const waitMax = configData.cookie ? 10000 : 5000;
        await delay(waitMin, waitMax);
      }
    } catch (error) {
      console.error(chalk.red.bold(`   ❌ Error fetching shelf page ${page}:`), (error as any).message);
      break;
    }
  }

  // Deduplicate by ID
  const uniqueBooks: BookMetadata[] = [];
  const seenIds = new Set<string>();
  for (const book of allBooks) {
    if (!seenIds.has(book.id)) {
      uniqueBooks.push(book);
      seenIds.add(book.id);
    }
  }

  // Automatically sync authors to cache
  try {
    const authorCache = await loadAuthorCache();
    await syncAuthorsToCache(uniqueBooks, authorCache);
  } catch (error) {
    // Ignore cache sync errors in scraper
  }

  return uniqueBooks;
}

export async function scrapeListBooks(listId: string, maxPages = Infinity): Promise<BookMetadata[]> {
  const configData = await loadConfig();
  let allBooks: BookMetadata[] = [];
  let page = 1;
  let hasNext = true;
  let lastPageFirstId = '';

  while (hasNext) {
    const url = `https://www.goodreads.com/list/show/${listId}?page=${page}`;
    
    try {
      const headers: any = { 'User-Agent': USER_AGENT };
      if (configData.cookie) headers['Cookie'] = configData.cookie;

      const response = await fetchWithRetry(url, {
        headers,
        timeout: TIMEOUT
      });

      const $ = cheerio.load(response.data);
      const pageBooks: BookMetadata[] = [];

      // Scope to .tableList to avoid "related books" at the bottom of the page
      $('.tableList .bookTitle').each((_, element) => {
        const $a = $(element);
        const title = $a.find('span[itemprop="name"]').text().trim() || $a.text().trim();
        const href = $a.attr('href') || '';
        const match = href.match(/\/book\/show\/(\d+)/);
        const id = match ? match[1] : '';

        if (id) {
          const parentTd = $a.closest('td');
          const $authorA = parentTd.find('.authorName');
          const author = $authorA.text().trim() || 'Unknown Author';
          const authorHref = $authorA.attr('href') || '';
          const authorMatch = authorHref.match(/\/author\/show\/([^?#\s/]+)/);
          const authorSlug = authorMatch ? authorMatch[1] : undefined;
          const authorId = authorSlug ? authorSlug.split('.')[0] : undefined;
          
          const positionText = $a.closest('tr').find('td.number').text().trim();
          const position = parseInt(positionText, 10) || 0;
          
          const staticRatings = parentTd.find('.greyText.smallText').text().match(/([\d,]+) rating/);
          let ratings = staticRatings ? staticRatings[1] : '0';
          
          let avgRating: string | undefined;
          const avgRatingMatch = parentTd.find('.greyText.smallText').text().match(/(\d\.\d{2}) avg rating/);
          if (avgRatingMatch) avgRating = avgRatingMatch[1];
          
          if (ratings === '0') {
            const minirating = parentTd.find('.minirating').text().trim();
            const ratingsMatch = minirating.match(/([\d,]+) rating/);
            if (ratingsMatch) ratings = ratingsMatch[1];

            if (!avgRating) {
              const avgMatch = minirating.match(/(\d\.\d{2}) avg rating/);
              if (avgMatch) avgRating = avgMatch[1];
            }
          }

          // Extract year from Listopia metadata
          const metaText = parentTd.find('.greyText.smallText').text().trim();
          const yearMatch = metaText.match(/(?:published|publication).*?(\d{4})/i) || metaText.match(/\b(?:18|19|20)\d{2}\b/);
          const published = yearMatch ? (yearMatch[1] || yearMatch[0]) : 'Unknown';

          const finalTitle = title || `Unknown Title [ID: ${id}]`;

          pageBooks.push({ id, title: finalTitle, author, authorId, authorSlug, position, ratings, avgRating, published, page });
        }
      });

      if (pageBooks.length === 0) {
        hasNext = false;
        break;
      }

      const firstIdOnThisPage = pageBooks[0].id;
      if (page > 1 && firstIdOnThisPage === lastPageFirstId) {
        console.log(chalk.red.bold(`   ⚠️ Warning: Goodreads is returning Page 1 content for Page ${page}.`));
        hasNext = false;
        break;
      }
      lastPageFirstId = firstIdOnThisPage;

      allBooks = allBooks.concat(pageBooks);

      const nextBtn = $('.next_page');
      if (nextBtn.length > 0 && !nextBtn.hasClass('disabled') && (maxPages === Infinity || page < maxPages)) {
        page++;
        await delay();
      } else {
        hasNext = false;
      }
    } catch (error) {
      console.error(chalk.red.bold(`   ❌ Non-fatal error fetching list ${listId} page ${page}:`), (error as any).message);
      break;
    }
  }

  // Deduplicate by ID
  const uniqueBooks: BookMetadata[] = [];
  const seenIds = new Set<string>();
  for (const book of allBooks) {
    if (!seenIds.has(book.id)) {
      uniqueBooks.push(book);
      seenIds.add(book.id);
    }
  }

  // Automatically sync authors to cache
  try {
    const authorCache = await loadAuthorCache();
    await syncAuthorsToCache(uniqueBooks, authorCache);
  } catch (error) {
    // Ignore cache sync errors in scraper
  }

  return uniqueBooks;
}

export async function scrapeListDescription(listId: string): Promise<string> {
  const configData = await loadConfig();
  const url = `https://www.goodreads.com/list/show/${listId}`;
  try {
    const headers: any = { 'User-Agent': USER_AGENT };
    if (configData.cookie) headers['Cookie'] = configData.cookie;

    const response = await fetchWithRetry(url, {
      headers,
      timeout: TIMEOUT
    });
    const $ = cheerio.load(response.data);
    return $('.listDescription').html() || $('.u-paddingBottomMedium.mediumText').html() || '';
  } catch (error) {
    return '';
  }
}

export async function scrapeTagCount(bookId: string, tag: string): Promise<number> {
  const configData = await loadConfig();
  const url = `https://www.goodreads.com/work/shelves/${bookId}`;
  try {
    const headers: any = { 'User-Agent': USER_AGENT };
    if (configData.cookie) headers['Cookie'] = configData.cookie;

    const response = await fetchWithRetry(url, {
      headers,
      timeout: TIMEOUT
    });
    const $ = cheerio.load(response.data);
    
    let count = 0;
    $('.shelfStat').each((_, el) => {
      const shelfName = $(el).find('.actionLinkLite').text().trim();
      if (shelfName.toLowerCase() === tag.toLowerCase()) {
        const countText = $(el).find('a.smallText').text().trim();
        const match = countText.match(/([\d,]+)/);
        if (match) {
          count = parseInt(match[1].replace(/,/g, ''), 10);
        }
      }
    });
    return count;
  } catch (error) {
    return 0;
  }
}

// Helper to internalize the logic of scraping from a loaded Cheerio instance
async function extractBookFromCheerio(id: string, $: cheerio.CheerioAPI): Promise<Partial<BookMetadata>> {
  // 1. Try to extract from the Next.js data blob (most reliable)
  const nextDataJson = $('#__NEXT_DATA__').html();
  if (nextDataJson) {
    try {
      const nextData = JSON.parse(nextDataJson);
      const apolloState = nextData.props?.pageProps?.apolloState || {};
      
      // Match bookKey robustly by legacyId
      const bookKey = Object.keys(apolloState).find(k => {
        if (!k.startsWith('Book:')) return false;
        const bookData = apolloState[k];
        return bookData && (bookData.legacyId === parseInt(id, 10) || bookData.legacyId === id);
      });
      const bookData = bookKey ? apolloState[bookKey] : null;
      
      if (bookData) {
        const title = bookData.title || bookData.titleComplete;
        if (!title) await handleStructuralWarning(`Could not find title in JSON blob for book ${id}. Site structure may have changed.`);
        
        let ratings = '0';
        let rawRatings = 0;
        let avgRating: string | undefined;

        // Resolve stats object directly or from work
        let statsObj = null;
        if (bookData.stats?.__ref) {
          statsObj = apolloState[bookData.stats.__ref];
        } else if (bookData.stats) {
          statsObj = bookData.stats;
        }

        if (!statsObj && bookData.work?.__ref) {
          const workData = apolloState[bookData.work.__ref];
          if (workData) {
            if (workData.stats?.__ref) {
              statsObj = apolloState[workData.stats.__ref];
            } else if (workData.stats) {
              statsObj = workData.stats;
            }
          }
        }

        if (statsObj && statsObj.ratingsCount !== undefined) {
          rawRatings = statsObj.ratingsCount;
          if (statsObj.averageRating !== undefined) {
            avgRating = statsObj.averageRating.toFixed(2);
          }
        } else {          await handleStructuralWarning(`Could not find ratings count in JSON blob for book ${id}.`);
        }
        
        if (rawRatings > 0) {
          ratings = rawRatings.toLocaleString('en-US');
        }

        let author = 'Unknown Author';
        const contribEdge = bookData.primaryContributorEdge;
        if (contribEdge && contribEdge.node?.__ref) {
          author = apolloState[contribEdge.node.__ref]?.name || author;
        } else {
          await handleStructuralWarning(`Could not find author in JSON blob for book ${id}.`);
        }
        
        let published = 'Unknown';
        
        // 1. Try work details first (usually original publication date - best for classics)
        if (bookData.work?.__ref) {
          const workData = apolloState[bookData.work.__ref];
          if (workData && workData.details?.publicationTime) {
            const date = new Date(workData.details.publicationTime);
            published = `${date.getFullYear()}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getDate().toString().padStart(2, '0')}`;
          }
        }
        
        // 2. Try specific book details second (if work date was null, e.g. for some newer titles/webtoons)
        if (published === 'Unknown' && bookData.details?.publicationTime) {
          const date = new Date(bookData.details.publicationTime);
          published = `${date.getFullYear()}.${(date.getMonth() + 1).toString().padStart(2, '0')}.${date.getDate().toString().padStart(2, '0')}`;
        }

        // 3. Page count from the specific book's details (ref or inline)
        let pages: string | undefined;
        const detailsRef = bookData.details?.__ref;
        const detailsObj = detailsRef ? apolloState[detailsRef] : bookData.details;
        if (detailsObj) {
          const numPages = detailsObj.numPages ?? detailsObj.pageCount;
          if (numPages !== undefined && numPages !== null) pages = String(numPages);
        }

        // If we found everything including a valid date, return it
        if (title && published !== 'Unknown') return { id, title, author, ratings, avgRating, published, pages };
        
        // If date is still unknown but we have a JSON title, keep note of it and proceed to DOM fallback
        if (title) {
           console.log(chalk.gray(`   (JSON found title but missing date for ${id}. Checking DOM...)`));
        }
      } else {
        await handleStructuralWarning(`Found JSON blob but could not locate book data for ID ${id}. Site structure may have changed.`);
      }
    } catch (e) {
      await handleStructuralWarning(`Failed to parse JSON blob for book ${id}: ${(e as any).message}`);
    }
  }

  // 2. Fallback to selectors (more surgical now)
  const titleEl = $('h1[data-testid="bookTitle"], h1.bookTitle, h1#bookTitle');
  const domTitle = titleEl.first().text().trim() || undefined;
  
  const authorEl = $('.ContributorLink, .authorName').first();
  const domAuthor = authorEl.text().trim() || undefined;
  
  const ratingsEl = $('[data-testid="ratingsCount"], .ratingCount');
  const ratingsCount = ratingsEl.text().trim();
  const ratingsMatch = ratingsCount.match(/([\d,]+)/);
  const domRatings = ratingsMatch ? ratingsMatch[1] : undefined;

  const avgRatingEl = $('[data-testid="averageRating"], .RatingStatistics__rating');
  const domAvgRating = avgRatingEl.first().text().trim() || undefined;

  // Find the block that actually contains the word "published"
  let publishedRaw = '';
  const pubInfoEl = $('[data-testid="publicationInfo"], .FeaturedDetails, #details .row');
  
  pubInfoEl.each((_, el) => {
    const cleanText = $(el).text().trim();
    if (/published/i.test(cleanText)) {
      // Look for Month Day, Year (e.g. "November 30, 2022")
      const monthRegex = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}/i;
      const match = cleanText.match(monthRegex);
      if (match) {
        publishedRaw = match[0];
        return false; // break
      }
      
      // Fallback: look for "published YYYY"
      const yearMatch = cleanText.match(/published\s+(\d{4})/i);
      if (yearMatch) {
        publishedRaw = yearMatch[0];
        return false; // break
      }

      // Final fallback: use the text block directly
      publishedRaw = cleanText;
    }
  });

  const domPublished = formatDate(publishedRaw, domTitle);

  // Page count from the details section (e.g. "Hardcover, 849 pages")
  let domPages: string | undefined;
  const detailsEl = $('[data-testid="details"], .FeaturedDetails, #details .row');
  detailsEl.each((_, el) => {
    const cleanText = $(el).text().trim();
    const pagesMatch = cleanText.match(/(\d[\d,]*)\s+pages?/);
    if (pagesMatch) {
      domPages = pagesMatch[1];
      return false; // break
    }
  });

  return { 
    id, 
    title: domTitle, 
    author: domAuthor, 
    ratings: domRatings, 
    avgRating: domAvgRating,
    published: domPublished,
    pages: domPages
  };
}

export async function scrapeBookBySearch(id: string, title: string, author: string): Promise<Partial<BookMetadata>> {
  const query = encodeURIComponent(`${title} ${author}`);
  const url = `https://www.goodreads.com/search?q=${query}`;
  const config = await loadConfig();

  try {
    const headers: any = { 'User-Agent': USER_AGENT };
    if (config.cookie) headers['Cookie'] = config.cookie;

    const response = await fetchWithRetry(url, { headers, timeout: TIMEOUT });
    const $ = cheerio.load(response.data);

    let foundDetails: Partial<BookMetadata> = { id };

    $('.tableList tr').each((_, el) => {
      const $el = $(el);
      const $title = $el.find('.bookTitle');
      const href = $title.attr('href') || '';
      const match = href.match(/\/book\/show\/(\d+)/);
      const entryId = match ? match[1] : '';

      if (entryId === id) {
        const entryTitle = $title.find('span[itemprop="name"]').text().trim() || $title.text().trim();
        const entryAuthor = $el.find('.authorName span[itemprop="name"]').text().trim() || $el.find('.authorName').text().trim();
        const metaText = $el.find('.greyText.smallText').first().text().trim();

        const ratingsMatch = metaText.match(/([\d,]+) rating/);
        const ratings = ratingsMatch ? ratingsMatch[1] : '0';

        const avgRatingMatch = metaText.match(/(\d\.\d{2}) avg rating/);
        const avgRating = avgRatingMatch ? avgRatingMatch[1] : undefined;

        const yearMatch = metaText.match(/(?:published|publication).*?(\d{4})/i) || metaText.match(/\b(?:18|19|20)\d{2}\b/);
        const published = yearMatch ? (yearMatch[1] || yearMatch[0]) : 'Unknown';

        foundDetails = { id, title: entryTitle, author: entryAuthor, ratings, avgRating, published };        return false; // break
      }
    });

    return foundDetails;
  } catch (error) {
    return { id };
  }
}

export interface AuthorListBook {
  id: string;
  title: string;
  author: string;
  authorId?: string;
  authorSlug?: string;
  ratings: string;
  avgRating?: string;
  published: string;
}

function parseAuthorStats($: cheerio.CheerioAPI): AuthorStats {
  const $authorLink = $('a.authorName[href*="/author/show/"]').first();
  const name = $authorLink.text().trim() || undefined;
  const href = $authorLink.attr('href') || '';
  const slugMatch = href.match(/\/author\/show\/([^?#\s/]+)/);
  const slug = slugMatch ? slugMatch[1] : undefined;
  const statsText = $('.leftContainer a.authorName[href*="/author/show/"]').first().parent().text();
  if (!statsText.trim()) return { name, slug };
  const avgMatch = statsText.match(/Average rating\s+([\d.]+)/);
  const ratingsMatch = statsText.match(/([\d,]+)\s+ratings/);
  const reviewsMatch = statsText.match(/([\d,]+)\s+reviews/);
  const shelvesMatch = statsText.match(/shelved\s+([\d,]+)\s+times/);
  return {
    averageRating: avgMatch ? avgMatch[1] : undefined,
    numRatings: ratingsMatch ? ratingsMatch[1] : undefined,
    numReviews: reviewsMatch ? reviewsMatch[1] : undefined,
    numShelves: shelvesMatch ? shelvesMatch[1] : undefined,
    name,
    slug
  };
}

function findAuthorEntryBySlug(authorCache: AuthorCache, slug: string): AuthorCacheEntry | undefined {
  for (const entry of Object.values(authorCache)) {
    if (entry.slug === slug) return entry;
  }
  return undefined;
}

async function updateAuthorStatsFromPage($: cheerio.CheerioAPI, authorSlug: string): Promise<void> {
  const stats = parseAuthorStats($);
  if (!stats.averageRating && !stats.numRatings && !stats.numReviews && !stats.numShelves) return;
  const authorCache = await loadAuthorCache();
  const entry = findAuthorEntryBySlug(authorCache, authorSlug);
  if (entry && updateAuthorStats(entry, stats)) {
    await saveAuthorCache(authorCache);
  }
}

function parseAuthorListBooks($: cheerio.CheerioAPI, authorSlug?: string): AuthorListBook[] {
  const books: AuthorListBook[] = [];
  $('.tableList tr, tr[itemscope][itemtype="http://schema.org/Book"]').each((_, el) => {
    const $el = $(el);
    const $title = $el.find('.bookTitle');
    const href = $title.attr('href') || '';
    const match = href.match(/\/book\/show\/(\d+)/);
    const entryId = match ? match[1] : '';
    if (!entryId) return;

    const entryTitle = $title.find('span[itemprop="name"]').text().trim() || $title.text().trim();
    const $authorLink = $el.find('a.authorName[href*="/author/show/"]');
    const entryAuthor = $authorLink.text().trim() || 'Unknown Author';
    const authorHref = $authorLink.attr('href') || '';
    const authorMatch = authorHref.match(/\/author\/show\/([^?#\s/]+)/);
    const entryAuthorId = authorMatch ? authorMatch[1].split('.')[0] : undefined;

    const metaText = $el.find('.greyText.smallText').first().text().trim();
    const ratingsMatch = metaText.match(/([\d,]+) rating/);
    const ratings = ratingsMatch ? ratingsMatch[1] : '0';
    const avgRatingMatch = metaText.match(/(\d\.\d{2}) avg rating/);
    const avgRating = avgRatingMatch ? avgRatingMatch[1] : undefined;
    const yearMatch = metaText.match(/(?:published|publication).*?(\d{4})/i) || metaText.match(/\b(?:18|19|20)\d{2}\b/);
    const published = yearMatch ? (yearMatch[1] || yearMatch[0]) : 'Unknown';

    books.push({ id: entryId, title: entryTitle, author: entryAuthor, authorId: entryAuthorId, authorSlug, ratings, avgRating, published });
  });
  return books;
}

export async function scrapeBookByAuthorPage(id: string, authorSlug: string, titleHint?: string): Promise<Partial<BookMetadata>> {
  const url = `https://www.goodreads.com/author/list/${authorSlug}`;
  const config = await loadConfig();

  try {
    const headers: any = { 'User-Agent': USER_AGENT };
    if (config.cookie) headers['Cookie'] = config.cookie;

    const response = await fetchWithRetry(url, { headers, timeout: TIMEOUT });
    const $ = cheerio.load(response.data);

    // Capture/refresh the author's overall stats whenever we scrape their page
    await updateAuthorStatsFromPage($, authorSlug);

    const exactTitleHint = titleHint ? titleHint.trim().toLowerCase() : null;
    const books = parseAuthorListBooks($, authorSlug);

    const idMatch = books.find(b => b.id === id) || null;
    const titleMatch = !idMatch && exactTitleHint ? (books.find(b => b.title.trim().toLowerCase() === exactTitleHint) || null) : null;

    if (idMatch) return idMatch;
    if (titleMatch) return titleMatch;
    return { id };
  } catch (error) {
    return { id };
  }
}

export async function scrapeAuthorStats(authorSlug: string): Promise<AuthorStats | undefined> {
  const url = `https://www.goodreads.com/author/list/${authorSlug}`;
  const config = await loadConfig();

  try {
    const headers: any = { 'User-Agent': USER_AGENT };
    if (config.cookie) headers['Cookie'] = config.cookie;

    const response = await fetchWithRetry(url, { headers, timeout: TIMEOUT });
    const $ = cheerio.load(response.data);
    const stats = parseAuthorStats($);
    if (!stats.averageRating && !stats.numRatings && !stats.numReviews && !stats.numShelves) return undefined;
    return stats;
  } catch (error) {
    return undefined;
  }
}

async function updateSuccessMetric(method: 'id' | 'search' | 'author', success: boolean) {
  const metricPath = path.join(process.cwd(), 'lastSuccessGetBookByNumber.json');
  try {
    const metric = await fs.readJson(metricPath);
    if (success) {
      metric.lastSuccess = new Date().toISOString();
      metric.successCount++;
      metric.lastMethod = method;
    } else {
      metric.failureCount++;
    }
    await fs.writeJson(metricPath, metric, { spaces: 2 });
  } catch (e) {
    // Ignore metric update errors
  }
}

export async function scrapeBookDetails(bookId: string, titleHint?: string, authorHint?: string, authorSlugHint?: string): Promise<Partial<BookMetadata> & { isFailed?: boolean }> {
  const url = `https://www.goodreads.com/book/show/${bookId}`;
  const config = await loadConfig();
  const authorCache = await loadAuthorCache();

  async function fetchAndParse(useCookie: boolean): Promise<Partial<BookMetadata>> {
    const headers: any = { 
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': 'https://www.goodreads.com/',
      'Sec-Ch-Ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"macOS"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    };
    if (useCookie && config.cookie) headers['Cookie'] = config.cookie;

    const response = await fetchWithRetry(url, { headers, timeout: TIMEOUT });

    if (response.status !== 200) {
      throw { status: response.status, data: response.data };
    }

    // Check if the body contains the "page not found" error despite a 200 status
    if (typeof response.data === 'string' && response.data.includes('couldn’t find the page you were looking for')) {
      throw { isNotFoundErrorPage: true, status: 404 };
    }

    const $ = cheerio.load(response.data);
    return await extractBookFromCheerio(bookId, $);
  }

  // Determine effective author slug
  let effectiveSlug = authorSlugHint;
  if (!effectiveSlug && authorHint) {
    effectiveSlug = authorCache[authorHint]?.slug;
  }

  // 1. Try Author Page first if we have a slug - very reliable summary view
  if (effectiveSlug) {
    const start = Date.now();
    try {
      console.log(chalk.gray(`   👤 [Method: Author List] Attempting for book ${bookId}${titleHint ? ` "${titleHint}"` : ''} (Author: ${effectiveSlug})...`));
      const authorDetails = await scrapeBookByAuthorPage(bookId, effectiveSlug, titleHint);
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      if (authorDetails.title && authorDetails.published !== 'Unknown') {
        console.log(chalk.gray(`      ✅ Success via Author List (${duration}s)`));
        await updateSuccessMetric('author', true);
        return authorDetails;
      }
      console.log(chalk.gray(`      ❌ Failed via Author List (${duration}s)`));
    } catch (e) {
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      console.log(chalk.gray(`      ❌ Error via Author List (${duration}s): ${(e as any).message}`));
    }
  }
 
/*
  // 2026-06-14 comment out mjf
 
  // 2. Try Search Fallback next
  if (titleHint && authorHint) {
    const start = Date.now();
    try {
      console.log(chalk.gray(`   🔍 [Method: Search] Attempting for book ${bookId} ("${titleHint.substring(0, 20)}")...`));
      const searchDetails = await scrapeBookBySearch(bookId, titleHint, authorHint);
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      if (searchDetails.title && searchDetails.published !== 'Unknown') {
        console.log(chalk.gray(`      ✅ Success via Search (${duration}s)`));
        await updateSuccessMetric('search', true);
        return searchDetails;
      }
      console.log(chalk.gray(`      ❌ Failed via Search (${duration}s)`));
    } catch (e) {
      const duration = ((Date.now() - start) / 1000).toFixed(2);
      console.log(chalk.gray(`      ❌ Error via Search (${duration}s): ${(e as any).message}`));
    }
  }

  // 3. Try direct fetch
  const idStart = Date.now();
  try {
    console.log(chalk.gray(`   🆔 [Method: Direct ID] Attempting for book ${bookId} (Unauthenticated)...`));
    const details = await fetchAndParse(false);
    const duration = ((Date.now() - idStart) / 1000).toFixed(2);
    console.log(chalk.gray(`      ✅ Success via Direct ID Unauth (${duration}s)`));
    await updateSuccessMetric('id', true);
    return details;
  } catch (error: any) {
    const status = error.status || error.response?.status;
    const isRestricted = error.isNotFoundErrorPage || status === 404 || status === 202;
    const duration = ((Date.now() - idStart) / 1000).toFixed(2);

    if (isRestricted && config.cookie) {
      console.log(chalk.yellow(`      🔒 Restricted (Status ${status}) after ${duration}s. Retrying with authentication...`));
      const authStart = Date.now();
      await delay(1000, 3000);
      try {
        const details = await fetchAndParse(true);
        const authDuration = ((Date.now() - authStart) / 1000).toFixed(2);
        console.log(chalk.gray(`      ✅ Success via Direct ID Auth (${authDuration}s)`));
        details.requiresAuth = true;
        await updateSuccessMetric('id', true);
        return details;
      } catch (authError) {
        const authDuration = ((Date.now() - authStart) / 1000).toFixed(2);
        console.log(chalk.gray(`      ❌ Failed via Direct ID Auth (${authDuration}s)`));
      }
    } else {
      console.log(chalk.gray(`      ❌ Failed via Direct ID Unauth (${duration}s, Status: ${status || 'Err'})`));
    }
  }
*/

  await updateSuccessMetric('id', false);
  return { id: bookId, isFailed: true };
}
