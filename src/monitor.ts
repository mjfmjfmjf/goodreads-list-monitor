import chalk from 'chalk';
import { scrapeAllUserLists, scrapeListBooks, scrapeBookDetails, ListMetadata, BookMetadata } from './scraper.js';
import { loadState, saveState, loadBookCache, saveBookCache, syncBooksToCache, loadAuthorCache, saveAuthorCache, syncAuthorsToCache, State, ListState } from './storage.js';
import { delay, formatDate, formatBookLink } from './utils.js';
import { appendToLog } from './logger.js';

export async function performIngest(userId: string, force = false): Promise<void> {
  const state = await loadState();
  const bookCache = await loadBookCache();
  const authorCache = await loadAuthorCache();
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
    if (force) return true;
    // Ingest if not marked ingested, OR if we have almost no books saved despite a high count
    return !l.ingested || (l.lastCount > 10 && l.seenBookIds.length < l.lastCount * 0.5);
  });
  console.log(chalk.yellow.bold(`📈 ${listsToIngest.length} lists need to be ingested.`));

  for (let i = 0; i < listsToIngest.length; i++) {
    const [id, listState] = listsToIngest[i];
    console.log(chalk.cyan.bold(`\n[${i + 1}/${listsToIngest.length}] Ingesting books for: "${listState.title}"`));
    
    try {
      const books = await scrapeListBooks(id);
      await syncBooksToCache(books, bookCache);
      await syncAuthorsToCache(books, authorCache);
      
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
  const authorCache = await loadAuthorCache();
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
        lastCount: 0, // Set to 0 to trigger ingestion logic below
        seenBookIds: [],
        ingested: false,
        discoveryPage: list.discoveryPage,
        url: list.url
      };
      await appendToLog(`DISCOVERED NEW LIST: "${list.title}" (ID: ${listId}, Count: ${list.bookCount})`);
    }

    // Update list metadata regardless of count change
    const targetList = state.lists[listId];
    targetList.title = list.title;
    targetList.url = list.url;
    targetList.discoveryPage = list.discoveryPage;

    if (list.bookCount > targetList.lastCount || !targetList.ingested) {
      if (!targetList.ingested) {
        console.log(chalk.cyan.bold(`📥 Ingesting metadata for newly discovered list: "${list.title}"`));
      } else {
        console.log(chalk.yellow.bold(`🔔 New book(s) added to "${list.title}"! Count: ${targetList.lastCount} -> ${list.bookCount}`));
      }
      
      console.log(chalk.gray(`   Scraping list "${list.title}" to identify new books and harvest metadata...`));
      const currentBooks = await scrapeListBooks(listId);
      await syncBooksToCache(currentBooks, bookCache);
      await syncAuthorsToCache(currentBooks, authorCache);
      
      const newBooks = currentBooks.filter(b => !targetList.seenBookIds.includes(b.id));

      if (newBooks.length > 0 && targetList.ingested) {
        for (const book of newBooks) {
          // Check cache (which was just updated by syncBooksToCache)
          let finalPub = bookCache[book.id]?.published || book.published;

          const bookLink = formatBookLink(bookCache[book.id]?.title || book.title, book.id);
          const msg = `ADDED to "${list.title}": ${bookLink} by ${bookCache[book.id]?.author || book.author} (Pos: ${book.position}, Ratings: ${bookCache[book.id]?.ratings || book.ratings}, Pub: ${finalPub})`;
          console.log(chalk.magenta.bold(`  ✨ ${msg}`));
          await appendToLog(msg);
        }
      }

      targetList.lastCount = list.bookCount;
      targetList.seenBookIds = currentBooks.map(b => b.id);
      targetList.ingested = true;
      changesFound = true;
      
      await delay();
    } else if (list.bookCount < targetList.lastCount) {
      console.log(chalk.red.bold(`⚠️ Book(s) removed from "${list.title}"! Count: ${targetList.lastCount} -> ${list.bookCount}`));

      const currentBooks = await scrapeListBooks(listId);
      await syncBooksToCache(currentBooks, bookCache);
      await syncAuthorsToCache(currentBooks, authorCache);
      
      const currentIds = currentBooks.map(b => b.id);
      const removedIds = targetList.seenBookIds.filter(id => !currentIds.includes(id));

      if (removedIds.length > 0) {
        for (const id of removedIds) {
          // Check global cache first
          let details = bookCache[id];
          
          if (!details || details.title === 'Unknown') {
            console.log(chalk.gray(`   Fetching missing details for removed book ID ${id}...`));
            const fetched = await scrapeBookDetails(id, details?.title, details?.author);
            details = {
                id,
                title: fetched.title || details?.title || 'Unknown',
                author: fetched.author || details?.author || 'Unknown',
                ratings: fetched.ratings || details?.ratings || '0',
                avgRating: fetched.avgRating || details?.avgRating,
                published: fetched.published || details?.published || 'Unknown',
                lastUpdated: new Date().toISOString(),
                tags: bookCache[id]?.tags || {}
            };
            bookCache[id] = details;
            await saveBookCache(bookCache);
            await delay();
          }
          
          const bookLink = formatBookLink(details.title, id);
          const avgStr = details.avgRating ? `, Avg: ${details.avgRating}` : '';
          const msg = `REMOVED from "${list.title}": ${bookLink} by ${details.author} (Ratings: ${details.ratings}${avgStr}, Published: ${details.published})`;
          console.log(chalk.red.bold(`  ❌ ${msg}`));
          await appendToLog(msg);
        }
      }

      targetList.lastCount = list.bookCount;
      targetList.seenBookIds = currentIds;
      targetList.title = list.title;
      changesFound = true;
    } else {
      targetList.title = list.title;
      targetList.lastCount = list.bookCount;
      targetList.url = list.url;
      targetList.discoveryPage = list.discoveryPage;
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
