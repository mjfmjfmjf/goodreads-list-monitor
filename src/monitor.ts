import chalk from 'chalk';
import { scrapeAllUserLists, scrapeListBooks, scrapeBookDetails, ListMetadata, BookMetadata } from './scraper.js';
import { loadState, saveState, loadBookCache, saveBookCache, State, ListState } from './storage.js';
import { delay, formatDate, formatBookLink } from './utils.js';
import { appendToLog } from './logger.js';

export async function performIngest(userId: string): Promise<void> {
  const state = await loadState();
  state.userId = userId;

  console.log(chalk.cyan.bold(`🚀 Starting initial ingest for user ${userId}...`));
  const currentLists = await scrapeAllUserLists(userId);
  
  for (const list of currentLists) {
    if (!state.lists[list.id]) {
      state.lists[list.id] = {
        title: list.title,
        lastCount: list.bookCount,
        seenBookIds: [],
        ingested: false,
        discoveryPage: list.discoveryPage,
        url: list.url
      };
    } else {
      // Sync metadata for existing lists to catch corrected counts
      state.lists[list.id].title = list.title;
      state.lists[list.id].lastCount = list.bookCount;
      state.lists[list.id].discoveryPage = list.discoveryPage;
      state.lists[list.id].url = list.url;
    }
  }
  await saveState(state);

  const listsToIngest = Object.entries(state.lists).filter(([_, l]) => {
    // Ingest if not marked ingested, OR if we have almost no books saved despite a high count
    return !l.ingested || (l.lastCount > 10 && l.seenBookIds.length < l.lastCount * 0.5);
  });
  console.log(chalk.yellow.bold(`📈 ${listsToIngest.length} lists need to be ingested.`));

  for (let i = 0; i < listsToIngest.length; i++) {
    const [id, listState] = listsToIngest[i];
    console.log(chalk.cyan.bold(`\n[${i + 1}/${listsToIngest.length}] Ingesting books for: "${listState.title}"`));
    
    try {
      const books = await scrapeListBooks(id);
      listState.seenBookIds = books.map(b => b.id);
      listState.lastCount = books.length;
      listState.ingested = true;
      
      await saveState(state);
      console.log(chalk.green.bold(`✅ Finished "${listState.title}" (${books.length} books stored).`));
      
      if (i < listsToIngest.length - 1) {
        await delay();
      }
    } catch (error) {
      console.error(chalk.red.bold(`❌ Failed to ingest "${listState.title}":`), (error as any).message);
      break;
    }
  }

  console.log(chalk.cyan.bold('\n🏁 Ingest process complete.'));
}

export async function checkUpdates(userId: string): Promise<void> {
  const state = await loadState();
  const bookCache = await loadBookCache();
  state.userId = userId;

  console.log(chalk.cyan.bold(`🚀 Starting update check for user ${userId}...`));
  const currentLists = await scrapeAllUserLists(userId);
  console.log(chalk.green.bold(`✅ Discovery complete. Found ${currentLists.length} lists total.`));

  let changesFound = false;

  for (const list of currentLists) {
    const listId = list.id;
    const existingList = state.lists[listId];

    if (!existingList) {
      console.log(chalk.cyan.bold(`🆕 New list discovered: "${list.title}" (${list.bookCount} books)`));
      state.lists[listId] = {
        title: list.title,
        lastCount: list.bookCount,
        seenBookIds: [],
        ingested: false,
        discoveryPage: list.discoveryPage,
        url: list.url
      };
      await appendToAuditReport('DISCOVERY', `NEW LIST: "${list.title}" (ID: ${listId}, Count: ${list.bookCount})`);
      changesFound = true;
    } else if (list.bookCount > existingList.lastCount) {
      console.log(chalk.yellow.bold(`🔔 New book(s) added to "${list.title}"! Count: ${existingList.lastCount} -> ${list.bookCount}`));
      
      console.log(chalk.gray(`   Scraping list "${list.title}" to identify new books...`));
      const currentBooks = await scrapeListBooks(listId);
      const newBooks = currentBooks.filter(b => !existingList.seenBookIds.includes(b.id));

      if (newBooks.length > 0) {
        for (const book of newBooks) {
          // 1. Try list-view date
          let finalPub = book.published;
          
          // 2. Check cache
          if (finalPub === 'Unknown' && bookCache[book.id] && bookCache[book.id].published !== 'Unknown') {
             finalPub = bookCache[book.id].published;
          }

          // 3. Last resort: Fetch details if still unknown
          if (finalPub === 'Unknown') {
            console.log(chalk.gray(`      (Fetching missing date for new book: "${book.title.substring(0, 30)}...")`));
            const fetched = await scrapeBookDetails(book.id);
            finalPub = fetched.published || 'Unknown';
            // Update cache while we are here
            bookCache[book.id] = {
              id: book.id,
              title: book.title,
              author: book.author,
              ratings: book.ratings,
              published: finalPub,
              lastUpdated: new Date().toISOString(),
              tags: bookCache[book.id]?.tags || {}
            };
            await saveBookCache(bookCache);
            await delay(500, 1500);
          }

          const bookLink = formatBookLink(book.title, book.id);
          const msg = `ADDED to "${list.title}": ${bookLink} by ${book.author} (Pos: ${book.position}, Ratings: ${book.ratings}, Pub: ${finalPub})`;
          console.log(chalk.magenta.bold(`  ✨ ${msg}`));
          await appendToLog(msg);
          
          // Sync cache if we haven't already
          if (!bookCache[book.id]) {
            bookCache[book.id] = {
              id: book.id,
              title: book.title,
              author: book.author,
              ratings: book.ratings,
              published: finalPub,
              lastUpdated: new Date().toISOString(),
              tags: {}
            };
          }
        }
        await saveBookCache(bookCache);
      }

      existingList.lastCount = list.bookCount;
      existingList.seenBookIds = currentBooks.map(b => b.id);
      existingList.title = list.title;
      existingList.ingested = true;
      changesFound = true;
      
      await delay();
    } else if (list.bookCount < existingList.lastCount) {
      console.log(chalk.red.bold(`⚠️ Book(s) removed from "${list.title}"! Count: ${existingList.lastCount} -> ${list.bookCount}`));

      const currentBooks = await scrapeListBooks(listId);
      const currentIds = currentBooks.map(b => b.id);
      const removedIds = existingList.seenBookIds.filter(id => !currentIds.includes(id));

      if (removedIds.length > 0) {
        for (const id of removedIds) {
          // Check global cache first
          let details = bookCache[id];
          
          if (!details || details.published === 'Unknown') {
            console.log(chalk.gray(`   Fetching missing details for removed book ID ${id}...`));
            const fetched = await scrapeBookDetails(id);
            details = {
                id,
                title: fetched.title || 'Unknown',
                author: fetched.author || 'Unknown',
                ratings: fetched.ratings || '0',
                published: fetched.published || 'Unknown',
                lastUpdated: new Date().toISOString(),
                tags: bookCache[id]?.tags || {}
            };
            bookCache[id] = details;
            await saveBookCache(bookCache);
            await delay();
          }
          
          const bookLink = formatBookLink(details.title, id);
          const msg = `REMOVED from "${list.title}": ${bookLink} by ${details.author} (Ratings: ${details.ratings}, Published: ${details.published})`;
          console.log(chalk.red.bold(`  ❌ ${msg}`));
          await appendToLog(msg);
        }
      }

      existingList.lastCount = list.bookCount;
      existingList.seenBookIds = currentIds;
      existingList.title = list.title;
      changesFound = true;
    } else {
      existingList.title = list.title;
      existingList.lastCount = list.bookCount;
      existingList.url = list.url;
      existingList.discoveryPage = list.discoveryPage;
    }
  }

  if (!changesFound) {
    console.log(chalk.gray('No new books added since last check.'));
  }

  await saveState(state);
  console.log(chalk.cyan.bold('🏁 Check complete. Local state updated on disk.'));
}

async function appendToAuditReport(listTitle: string, message: string): Promise<void> {
  // Use existing logger or local logic
  await appendToLog(`[${listTitle}] ${message}`);
}
