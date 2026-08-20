#!/usr/bin/env node
// migrateToSqlite.ts — one-time migration from JSON caches to SQLite
//
// Usage:
//   npx ts-node src/migrateToSqlite.ts
//
// Backs up the original JSON files, imports them into goodreads.db,
// and prints a summary of what was imported.

import fs from 'fs-extra';
import path from 'path';
import { getDb, closeDb } from './db.js';

const CWD = process.cwd();
const BACKUP_DIR = path.join(CWD, 'json-backup');

interface CachedBook {
  id: string;
  title: string;
  author: string;
  authorId?: string;
  ratings: string;
  avgRating?: string;
  published: string;
  pages?: string;
  seriesPos?: number;
  genres?: string[];
  lastUpdated: string;
  tags?: { [tagName: string]: number };
  requiresAuth?: boolean;
  isBad?: boolean;
  failCount?: number;
}

interface AuthorCacheEntry {
  id: string;
  slug: string;
  lastSeen: string;
  averageRating?: string;
  numRatings?: string;
  numReviews?: string;
  numShelves?: string;
}

function parseNum(s?: string): number {
  return parseInt((s || '0').replace(/,/g, ''), 10) || 0;
}

async function migrate() {
  console.log('🔄 Migrating JSON caches to SQLite...\n');

  // Create backup directory
  await fs.ensureDir(BACKUP_DIR);

  const db = getDb();

  // ── Books ──────────────────────────────────────────────────────
  const booksFile = path.join(CWD, 'booksCache.json');
  if (await fs.pathExists(booksFile)) {
    console.log('📚 Importing books...');
    const books: { [id: string]: CachedBook } = await fs.readJson(booksFile);
    const entries = Object.values(books);
    console.log(`   Found ${entries.length} books in booksCache.json`);

    const upsert = db.prepare(`
      INSERT INTO books (id, title, author, author_id, ratings, avg_rating, published, pages, series_pos, genres, last_updated, tags, requires_auth, is_bad, fail_count)
      VALUES (@id, @title, @author, @authorId, @ratings, @avgRating, @published, @pages, @seriesPos, @genres, @lastUpdated, @tags, @requiresAuth, @isBad, @failCount)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title, author=excluded.author, author_id=excluded.author_id,
        ratings=excluded.ratings, avg_rating=excluded.avg_rating, published=excluded.published,
        pages=excluded.pages, series_pos=excluded.series_pos, genres=excluded.genres,
        last_updated=excluded.last_updated, tags=excluded.tags,
        requires_auth=excluded.requires_auth, is_bad=excluded.is_bad, fail_count=excluded.fail_count
    `);

    const tx = db.transaction(() => {
      for (const book of entries) {
        upsert.run({
          id: book.id,
          title: book.title,
          author: book.author,
          authorId: book.authorId || null,
          ratings: parseNum(book.ratings),
          avgRating: book.avgRating ? parseFloat(book.avgRating) : null,
          published: book.published,
          pages: book.pages ? parseInt(book.pages, 10) : null,
          seriesPos: book.seriesPos ?? null,
          genres: book.genres ? JSON.stringify(book.genres) : null,
          lastUpdated: book.lastUpdated,
          tags: book.tags ? JSON.stringify(book.tags) : null,
          requiresAuth: book.requiresAuth ? 1 : 0,
          isBad: book.isBad ? 1 : 0,
          failCount: book.failCount ?? null,
        });
      }
    });
    tx();

    const dbCount = (db.prepare('SELECT COUNT(*) as n FROM books').get() as any).n;
    console.log(`   ✅ Imported ${dbCount} books into SQLite`);

    // Backup original
    await fs.copy(booksFile, path.join(BACKUP_DIR, 'booksCache.json'));
    console.log(`   📁 Backed up to ${path.join(BACKUP_DIR, 'booksCache.json')}`);
  } else {
    console.log('📚 No booksCache.json found, skipping');
  }

  // ── Authors ────────────────────────────────────────────────────
  const authorsFile = path.join(CWD, 'authorsCache.json');
  if (await fs.pathExists(authorsFile)) {
    console.log('\n👤 Importing authors...');
    const authors: { [name: string]: AuthorCacheEntry } = await fs.readJson(authorsFile);
    const entries = Object.entries(authors);
    console.log(`   Found ${entries.length} authors in authorsCache.json`);

    const upsert = db.prepare(`
      INSERT INTO authors (name, id, slug, last_seen, average_rating, num_ratings, num_reviews, num_shelves)
      VALUES (@name, @id, @slug, @lastSeen, @averageRating, @numRatings, @numReviews, @numShelves)
      ON CONFLICT(name) DO UPDATE SET
        id=excluded.id, slug=excluded.slug, last_seen=excluded.last_seen,
        average_rating=excluded.average_rating, num_ratings=excluded.num_ratings,
        num_reviews=excluded.num_reviews, num_shelves=excluded.num_shelves
    `);

    const tx = db.transaction(() => {
      for (const [name, entry] of entries) {
        upsert.run({
          name,
          id: entry.id,
          slug: entry.slug,
          lastSeen: entry.lastSeen,
          averageRating: entry.averageRating ? parseFloat(entry.averageRating) : null,
          numRatings: parseNum(entry.numRatings),
          numReviews: parseNum(entry.numReviews),
          numShelves: parseNum(entry.numShelves),
        });
      }
    });
    tx();

    const dbCount = (db.prepare('SELECT COUNT(*) as n FROM authors').get() as any).n;
    console.log(`   ✅ Imported ${dbCount} authors into SQLite`);

    await fs.copy(authorsFile, path.join(BACKUP_DIR, 'authorsCache.json'));
    console.log(`   📁 Backed up to ${path.join(BACKUP_DIR, 'authorsCache.json')}`);
  } else {
    console.log('\n👤 No authorsCache.json found, skipping');
  }

  // ── Config ─────────────────────────────────────────────────────
  const configFile = path.join(CWD, 'config.json');
  if (await fs.pathExists(configFile)) {
    console.log('\n⚙️  Importing config...');
    const config: { cookie?: string } = await fs.readJson(configFile);
    if (config.cookie) {
      db.prepare(`
        INSERT INTO config (key, value) VALUES ('cookie', @value)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run({ value: config.cookie });
      console.log('   ✅ Imported cookie');
    }
    await fs.copy(configFile, path.join(BACKUP_DIR, 'config.json'));
    console.log(`   📁 Backed up to ${path.join(BACKUP_DIR, 'config.json')}`);
  } else {
    console.log('\n⚙️  No config.json found, skipping');
  }

  // ── State ──────────────────────────────────────────────────────
  const stateFile = path.join(CWD, 'state.json');
  if (await fs.pathExists(stateFile)) {
    console.log('\n📋 Importing state...');
    const state: { userId: string; lists: { [id: string]: any } } = await fs.readJson(stateFile);

    const tx = db.transaction(() => {
      if (state.userId) {
        db.prepare(`
          INSERT INTO config (key, value) VALUES ('userId', @value)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).run({ value: state.userId });
      }

      const insert = db.prepare(`
        INSERT INTO lists (list_id, title, last_count, seen_book_ids, ingested, discovery_page, url)
        VALUES (@listId, @title, @lastCount, @seenBookIds, @ingested, @discoveryPage, @url)
      `);
      for (const [listId, list] of Object.entries(state.lists || {})) {
        insert.run({
          listId,
          title: list.title,
          lastCount: list.lastCount || 0,
          seenBookIds: JSON.stringify(list.seenBookIds || []),
          ingested: list.ingested ? 1 : 0,
          discoveryPage: list.discoveryPage ?? null,
          url: list.url ?? null,
        });
      }
    });
    tx();

    const listCount = (db.prepare('SELECT COUNT(*) as n FROM lists').get() as any).n;
    console.log(`   ✅ Imported userId + ${listCount} lists`);

    await fs.copy(stateFile, path.join(BACKUP_DIR, 'state.json'));
    console.log(`   📁 Backed up to ${path.join(BACKUP_DIR, 'state.json')}`);
  } else {
    console.log('\n📋 No state.json found, skipping');
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log('\n📊 Migration summary:');
  const bookCount = (db.prepare('SELECT COUNT(*) as n FROM books').get() as any).n;
  const authorCount = (db.prepare('SELECT COUNT(*) as n FROM authors').get() as any).n;
  const configCount = (db.prepare('SELECT COUNT(*) as n FROM config').get() as any).n;
  const listCount = (db.prepare('SELECT COUNT(*) as n FROM lists').get() as any).n;
  console.log(`   Books:   ${bookCount.toLocaleString()}`);
  console.log(`   Authors: ${authorCount.toLocaleString()}`);
  console.log(`   Config:  ${configCount} entries`);
  console.log(`   Lists:   ${listCount}`);

  const dbPath = path.join(CWD, 'goodreads.db');
  const dbSize = (await fs.stat(dbPath)).size;
  console.log(`\n   Database: ${dbPath} (${(dbSize / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`   Backups:  ${BACKUP_DIR}/`);

  closeDb();
  console.log('\n✅ Migration complete. JSON files backed up but preserved.');
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
