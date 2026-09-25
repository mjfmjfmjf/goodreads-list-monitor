import chalk from 'chalk';
import { getDb } from './db.js';
import { loadTagSets, rankPairings } from './genrePairings.js';

export interface TagPairingOptions {
  tag?: string;          // restrict to a single non-genre tag
  limit?: string;        // top-K genres per tag (default 5)
  minBooks?: string;     // only consider non-genre tags with >= this many books
  maxResults?: string;   // max non-genre tags to report (default all)
  minJaccard?: string;   // only show a tag whose best genre match is >= this %; list only matches at/above it
  loadXref?: string;     // REBUILD the tag→genre xref (kind=similarity) for matches >= this %, then exit
}

export interface XrefChange {
  tag: string;        // the non-genre tag (row key)
  books: number;      // tag book-set size (may be 0 if the tag vanished)
  oldGenre?: string;  // previous similarity mapping (changed/removed)
  genre?: string;     // new similarity mapping (added/changed)
  pct?: number;       // similarity % of the new mapping (added/changed)
}

export interface SimilarityXrefReport {
  added: XrefChange[];   // no similarity row before, now qualifies
  changed: XrefChange[]; // had a similarity row, best genre re-pointed (oldGenre -> genre)
  removed: XrefChange[]; // had a similarity row, no longer qualifies (below bar / became a genre)
  kept: number;          // unchanged similarity rows
  curatedKept: number;   // tags with an exact/cognate (non-similarity) row — left untouched
  skipped: number;       // no best match >= bar, and no prior similarity row
}

// Incrementally sync all tag->genre xref rows of kind='similarity' for
// non-genre tags, reporting exactly what changed. Per tag:
//   - no row yet, best match >= bar      -> INSERT new row (added)
//   - row exists, best genre changed     -> UPDATE genre (+1 row, old -> new)
//   - row exists, same genre             -> untouched (kept)
//   - row exists, now below bar / gone   -> DELETE that one row (removed)
// Curated exact/cognate mappings win and are never modified; a curated tag's
// stale similarity row (the old upsert bug artifact) is removed. The sync is
// atomic (single transaction). Only the rows that actually change are written.
export function writeSimilarityXref(minPct: number): SimilarityXrefReport {
  const db = getDb();
  const { tagSets, nonGenreTags } = loadTagSets();
  const genreSet = new Set<string>((db.prepare('SELECT name FROM genres').all() as any[]).map(r => r.name));
  const genreTagSets = [...tagSets.entries()]
    .filter(([name]) => genreSet.has(name))
    .map(([tag, books]) => ({ tag, books }));

  const curatedTags = new Set<string>();
  const simByTag = new Map<string, string>();
  for (const r of db.prepare('SELECT tag_name, genre_name, kind FROM genre_tag_xref').all() as any[]) {
    if (r.kind === 'similarity') simByTag.set(r.tag_name, r.genre_name);
    else curatedTags.add(r.tag_name);
  }

  const added: XrefChange[] = [];
  const changed: XrefChange[] = [];
  const removed: XrefChange[] = [];
  let kept = 0;
  let curatedKept = 0;
  let skipped = 0;

  const inserts: Array<[string, string]> = [];
  const updates: Array<[string, string]> = [];   // [tag, newGenre]
  const deletes: string[] = [];                  // tag_names to drop their similarity row

  for (const tag of nonGenreTags) {
    if (curatedTags.has(tag)) {
      curatedKept++;
      if (simByTag.has(tag)) {
        removed.push({ tag, books: tagSets.get(tag)?.size ?? 0, oldGenre: simByTag.get(tag), pct: undefined });
        deletes.push(tag);
      }
      continue;
    }
    const books = tagSets.get(tag)!;
    const best = rankPairings(books, genreTagSets).sort((a, b) => b.jaccard - a.jaccard || b.overlap - a.overlap)[0];
    const oldGenre = simByTag.get(tag);
    if (!best || best.pct < minPct) {
      if (oldGenre !== undefined) {
        removed.push({ tag, books: books.size, oldGenre, pct: undefined });
        deletes.push(tag);
      } else {
        skipped++;
      }
      continue;
    }
    if (oldGenre === undefined) {
      added.push({ tag, books: books.size, genre: best.tag, pct: best.pct });
      inserts.push([tag, best.tag]);
    } else if (oldGenre === best.tag) {
      kept++;
    } else {
      changed.push({ tag, books: books.size, oldGenre, genre: best.tag, pct: best.pct });
      updates.push([tag, best.tag]);
    }
  }

  if (inserts.length > 0 || updates.length > 0 || deletes.length > 0) {
    const tx = db.transaction(() => {
      const ins = db.prepare('INSERT INTO genre_tag_xref (genre_name, tag_name, kind) VALUES (?, ?, ?)');
      const upd = db.prepare('UPDATE genre_tag_xref SET genre_name = ? WHERE tag_name = ? AND kind = ?');
      const del = db.prepare('DELETE FROM genre_tag_xref WHERE tag_name = ? AND kind = ?');
      for (const [tag, genre] of inserts) ins.run(genre, tag, 'similarity');
      for (const [tag, genre] of updates) upd.run(genre, tag, 'similarity');
      for (const tag of deletes) del.run(tag, 'similarity');
    });
    tx();
  }

  return { added, changed, removed, kept, curatedKept, skipped };
}

export function computeTagPairings(options: TagPairingOptions = {}): void {
  const db = getDb();
  const { tagSets, nonGenreTags } = loadTagSets();

  const topK = options.limit ? parseInt(options.limit, 10) : 5;
  const minBooks = options.minBooks ? parseInt(options.minBooks, 10) : 0;
  const maxResults = options.maxResults ? parseInt(options.maxResults, 10) : Infinity;
  const minJaccard = options.minJaccard !== undefined ? parseFloat(options.minJaccard) : 0;

  const loadPct = options.loadXref !== undefined ? parseFloat(options.loadXref) : NaN;
  if (!isNaN(loadPct)) {
    const res = writeSimilarityXref(loadPct);
    const list = (title: string, items: XrefChange[], toGenre: boolean) => {
      if (items.length === 0) return;
      console.log(chalk.gray(`\n   ${chalk.white.bold(title)} (${items.length}):`));
      const shown = items.slice(0, 25);
      for (const it of shown) {
        if (toGenre) {
          const from = it.oldGenre ? chalk.yellow(` ${it.oldGenre} → `) : '';
          console.log(chalk.gray(`     ── ${chalk.white(it.tag)}${it.books > 0 ? chalk.gray(` (${it.books.toLocaleString()} bks)`) : ''} ${from}${chalk.green(it.genre)}${it.pct !== undefined ? chalk.gray(` @ ${it.pct.toFixed(1)}%`) : ''}`));
        } else {
          console.log(chalk.gray(`     ── ${chalk.white(it.tag)}${it.books > 0 ? chalk.gray(` (${it.books.toLocaleString()} bks)`) : ''} ${chalk.gray('was →')} ${chalk.red(it.oldGenre)}`));
        }
      }
      if (items.length > shown.length) console.log(chalk.gray(`     … ${items.length - shown.length} more`));
    };
    console.log(chalk.cyan.bold(`\n🔗 Synced tag→genre xref (kind=similarity) against pairings ≥ ${loadPct}%`));
    console.log(chalk.gray(`   +${res.added.length} added · ${res.changed.length} changed · ${res.kept} kept · ${res.removed.length} removed · ${res.curatedKept} curated kept · ${res.skipped} skipped (no prior row)`));
    list('Added', res.added, true);
    list('Changed', res.changed, true);
    list('Removed', res.removed, false);
    if (res.kept === 0 && res.added.length === 0 && res.changed.length === 0 && res.removed.length === 0) {
      console.log(chalk.green('   (no changes — xref already up to date)'));
    }
    return;
  }

  const genreSet = new Set<string>((db.prepare('SELECT name FROM genres').all() as any[]).map(r => r.name));
  // "tags that are genres" = tags whose name is also a genre AND that have a book set.
  const genreTagSets = [...tagSets.entries()]
    .filter(([name]) => genreSet.has(name))
    .map(([tag, books]) => ({ tag, books }));

  let subjects = [...tagSets.entries()]
    .filter(([name]) => !genreSet.has(name))
    .filter(([, books]) => books.size >= minBooks)
    .map(([tag, books]) => ({ tag, books }));

  const single = options.tag ? [options.tag] : null;
  if (single && single[0]) {
    const hit = subjects.find(s => s.tag === single[0]);
    if (!hit) { console.log(chalk.yellow(`   "${single[0]}" is either not a scraped tag, or is a genre-tag (try a non-genre tag, or genre-tag-pairings).`)); return; }
    subjects = [hit];
  }

  if (genreTagSets.length === 0) {
    console.log(chalk.yellow('\n   No genres are scraped as tags yet (no book sets). Scrape gap genres first.'));
    return;
  }

  console.log(chalk.cyan.bold('\n🔖 Tag ↔ genre pairings (each non-genre tag vs all genre-tags, by Jaccard)'));
  console.log(chalk.gray(`   Non-genre tags: ${subjects.length} · Genre-tags available: ${chalk.white(String(genreTagSets.length))} · top ${topK} each${minJaccard > 0 ? chalk.white(` · min match ${minJaccard}%`) : ''}`));

  const slice = subjects.slice(0, maxResults);
  let shownTags = 0;
  let skipped = 0;
  for (const subj of slice) {
    const pairings = rankPairings(subj.books, genreTagSets)
      .sort((a, b) => b.jaccard - a.jaccard || b.overlap - a.overlap);
    const qualifying = minJaccard > 0 ? pairings.filter(p => p.pct >= minJaccard) : pairings;
    if (qualifying.length === 0) {
      if (minJaccard > 0) {
        // no genre match meets the bar — skip the tag entirely
        skipped++;
        continue;
      }
      console.log(chalk.gray(`\n── ${chalk.white.bold(subj.tag)} (${subj.books.size.toLocaleString()} bks)`));
      console.log(chalk.gray(`     (no overlap with any scraped genre)`));
      continue;
    }
    shownTags++;
    console.log(chalk.gray(`\n── ${chalk.white.bold(subj.tag)} (${subj.books.size.toLocaleString()} bks)`));
    const shown = qualifying.slice(0, topK);
    for (let i = 0; i < shown.length; i++) {
      const p = shown[i];
      const bar = '█'.repeat(Math.max(1, Math.round(p.pct / 5)));
      console.log(`  ${String(i + 1).padStart(2)}. ${p.pct.toFixed(1).padStart(5)}%  ${chalk.green(String(p.overlap)).padStart(5)}/Δ${String(p.union).padStart(5)}  ${chalk.gray(bar)} ${chalk.white(p.tag)}`);
    }
  }
  if (minJaccard > 0) {
    console.log(chalk.gray(`\n   ${shownTags.toLocaleString()} tag(s) with a genre match ≥ ${minJaccard}% · ${skipped.toLocaleString()} tag(s) skipped (below the bar).`));
  }
  if (slice.length < subjects.length) {
    console.log(chalk.gray(`\n   … ${subjects.length - slice.length} more non-genre tags (use --maxResults).`));
  }
}
