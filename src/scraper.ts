import * as cheerio from 'cheerio';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { delay, fetchWithRetry, formatDate } from './utils.js';
import { loadConfig } from './storage.js';

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
  position: number;
  ratings: string;
  published: string;
  tagCount?: number;
  page?: number;
  requiresAuth?: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT = 30000; // 30 seconds

export async function scrapeAllUserLists(userId: string): Promise<ListMetadata[]> {
  let allLists: ListMetadata[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    console.log(chalk.cyan.bold(`🌐 Scraping discovery page ${page}...`));
    const url = `https://www.goodreads.com/list/created/${userId}?page=${page}`;
    
    try {
      const response = await fetchWithRetry(url, {
        headers: { 'User-Agent': USER_AGENT },
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
        const title = $title.text().trim();
        const href = $title.attr('href') || '';
        const match = href.match(/\/book\/show\/(\d+)/);
        const id = match ? match[1] : '';

        if (id) {
          if (i === 0) firstIdOnThisPage = id;

          const author = $el.find('.authorName').text().trim() || 'Unknown Author';
          const metaText = $el.find('.greyText.smallText').text().trim();
          
          const ratingsMatch = metaText.match(/([\d,]+) rating/);
          const ratings = ratingsMatch ? ratingsMatch[1] : '0';

          const yearMatch = metaText.match(/published (\d{4})/);
          const published = yearMatch ? yearMatch[1] : 'Unknown';

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

          pageBooks.push({ id, title, author, position: 0, ratings, published, tagCount: tagCount ?? 0 });
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

  return uniqueBooks;
}

export async function scrapeListBooks(listId: string, maxPages = Infinity): Promise<BookMetadata[]> {
  let allBooks: BookMetadata[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const url = `https://www.goodreads.com/list/show/${listId}?page=${page}`;
    
    try {
      const response = await fetchWithRetry(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: TIMEOUT
      });

      const $ = cheerio.load(response.data);
      const pageBooks: BookMetadata[] = [];

      $('.bookTitle').each((_, element) => {
        const $a = $(element);
        const title = $a.text().trim();
        const href = $a.attr('href') || '';
        const match = href.match(/\/book\/show\/(\d+)/);
        const id = match ? match[1] : '';

        if (id) {
          const parentTd = $a.closest('td');
          const author = parentTd.find('.authorName').text().trim() || 'Unknown Author';
          const positionText = $a.closest('tr').find('td.number').text().trim();
          const position = parseInt(positionText, 10) || 0;
          
          const minirating = parentTd.find('.minirating').text().trim();
          const ratingsMatch = minirating.match(/([\d,]+) rating/);
          const ratings = ratingsMatch ? ratingsMatch[1] : '0';

          // Extract year from Listopia metadata
          const metaText = parentTd.find('.greyText.smallText').text().trim();
          const yearMatch = metaText.match(/published (\d{4})/);
          const published = yearMatch ? yearMatch[1] : 'Unknown';

          const finalTitle = title || `Unknown Title [ID: ${id}]`;

          pageBooks.push({ id, title: finalTitle, author, position, ratings, published, page });
        }
      });

      allBooks = allBooks.concat(pageBooks);

      const nextBtn = $('.next_page');
      if (nextBtn.length > 0 && !nextBtn.hasClass('disabled') && pageBooks.length > 0 && (maxPages === Infinity || page < maxPages)) {
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

  return allBooks;
}

export async function scrapeListDescription(listId: string): Promise<string> {
  const url = `https://www.goodreads.com/list/show/${listId}`;
  try {
    const response = await fetchWithRetry(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: TIMEOUT
    });
    const $ = cheerio.load(response.data);
    return $('.listDescription').html() || $('.u-paddingBottomMedium.mediumText').html() || '';
  } catch (error) {
    return '';
  }
}

export async function scrapeTagCount(bookId: string, tag: string): Promise<number> {
  const url = `https://www.goodreads.com/work/shelves/${bookId}`;
  try {
    const response = await fetchWithRetry(url, {
      headers: { 'User-Agent': USER_AGENT },
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
        } else {
          await handleStructuralWarning(`Could not find ratings count in JSON blob for book ${id}.`);
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

        // If we found everything including a valid date, return it
        if (title && published !== 'Unknown') return { id, title, author, ratings, published };
        
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
  const titleEl = $('h1[data-testid="bookTitle"]');
  const domTitle = titleEl.text().trim() || `Unknown Title [ID: ${id}]`;
  
  const authorEl = $('.ContributorLink').first();
  const domAuthor = authorEl.text().trim() || 'Unknown Author';
  
  const ratingsEl = $('[data-testid="ratingsCount"]');
  const ratingsCount = ratingsEl.text().trim();
  const ratingsMatch = ratingsCount.match(/([\d,]+)/);
  const domRatings = ratingsMatch ? ratingsMatch[1] : '0';

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

  return { 
    id, 
    title: domTitle, 
    author: domAuthor, 
    ratings: domRatings, 
    published: domPublished 
  };
}

export async function scrapeBookDetails(bookId: string): Promise<Partial<BookMetadata>> {
  const url = `https://www.goodreads.com/book/show/${bookId}`;
  const config = await loadConfig();

  async function fetchAndParse(useCookie: boolean): Promise<Partial<BookMetadata>> {
    const headers: any = { 'User-Agent': USER_AGENT };
    if (useCookie && config.cookie) headers['Cookie'] = config.cookie;

    const response = await fetchWithRetry(url, { headers, timeout: TIMEOUT });
    
    // Check if the body contains the "page not found" error despite a 200 status
    if (typeof response.data === 'string' && response.data.includes('couldn’t find the page you were looking for')) {
      throw { isNotFoundErrorPage: true, status: 404 };
    }
    
    const $ = cheerio.load(response.data);
    return await extractBookFromCheerio(bookId, $);
  }

  try {
    // 1. Try without credentials first
    return await fetchAndParse(false);
  } catch (error: any) {
    const isRestricted = error.isNotFoundErrorPage || error.response?.status === 404;
    
    // 2. If it looks like a restricted page and we have a cookie, try with auth
    if (isRestricted && config.cookie) {
      console.log(chalk.yellow(`   🔒 Book ${bookId} restricted or 404. Waiting for authenticated retry...`));
      // Authenticated requests wait twice as long
      await delay(2000, 4000); 

      try {
        const details = await fetchAndParse(true);
        details.requiresAuth = true;
        return details;
      } catch (authError) {
        // If it still fails, it's a real 404 or something else
      }
    }

    return { id: bookId, title: `Unknown Title [ID: ${bookId}]`, author: 'Unknown Author', ratings: '0', published: 'Unknown' };
  }
}
