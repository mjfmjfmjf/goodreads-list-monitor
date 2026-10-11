import chalk from 'chalk';
import { getDb } from './db.ts';
import { countBooks } from './storage.ts';

export interface AuthorRolesOptions {
  role?: string;
  authors?: boolean;
  all?: boolean;
  limit?: string | number;
  minBooks?: string | number;
}

export const DEFAULT_ROLE_LIMIT = 40;

// ── Role vocabulary ────────────────────────────────────────────────
// Goodreads appends a contributor role to the author string — "Vincenzo
// Bellini(Composer)", "John Joseph Adams(Editor)" — and the raw form survives
// in books.author. Org-name parens live in the same syntax ("British Museum
// (Natural History)", "…(USA)"), so candidates are matched against this
// curated vocabulary instead of accepting every "(…)". Compare normalized
// (lowercased, spaces around "/" collapsed), so "Editor / Contributor" and
// "editor/contributor" are one entry. --all bypasses the filter to surface
// candidates worth adding.
const ROLE_VOCAB = new Set<string>([
  'editor', 'editor/contributor', 'writer', 'illustrator', 'contributor',
  'pseudonym', 'creator', 'adapter', 'adaptor', 'artist', 'translator',
  'photographer', 'compiler', 'composer', 'foreword', 'introduction',
  'house name', 'narrator', 'author', 'adapted by', 'illustrations',
  'illustration', 'cover', 'cover art', 'cover artist', 'cover designer',
  'designer', 'afterword', 'preface', 'commentary', 'annotations',
  'retold by', 'revised by', 'screenwriter', 'screenplay', 'lyricist',
  'librettist', 'performer', 'producer', 'director', 'series editor',
  'translation', 'traduction', 'guion', 'lettering', 'colorist', 'inker',
  'penciller', 'concept art', 'layout', 'layouts', 'photography',
  'photographs', 'abridgement', 'abridged by', 'foreword by',
]);

// Paren-group candidates: a trailing "(Role)" and mid-string "(Role)" that a
// run-on concatenation leaves behind ("Heinrich Harrer (Author)Dalai Lama
// XIV"). Word chars plus the separators real roles use ("Editor/Contributor",
// "Cover Art", "House Name"). Deliberately not matched: "(USA)"-style org
// tails are *returned* as candidates — the vocabulary decides what counts.
const TRAILING_RE = /\(([A-Za-z][A-Za-z0-9 &'/-]{0,39})\)\s*$/;
const MID_RE = /\(([A-Za-z][A-Za-z0-9 &'/-]{0,39})\)(?=[A-Z(])/g;

export function normalizeRole(raw: string): string {
  return raw.toLowerCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
}

// Every paren candidate in one author string, normalized, deduped, in order.
export function extractCandidates(authorText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const norm = normalizeRole(raw);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };
  // Mid-string groups come first textually (they are always left of the
  // trailing group), so candidates come back in reading order.
  for (const m of authorText.matchAll(MID_RE)) push(m[1]);
  push(authorText.match(TRAILING_RE)?.[1]);
  return out;
}

// Roles this report counts: vocabulary-filtered unless --all.
export function selectRoles(authorText: string, all = false): string[] {
  const candidates = extractCandidates(authorText);
  return all ? candidates : candidates.filter((c) => ROLE_VOCAB.has(c));
}

export interface RoleCount {
  role: string;
  books: number;
}

// Most books first, ties alphabetical — stable across runs so two reports diff.
export function rankRoleCounts(
  counts: Iterable<[string, number]>,
  opts: { limit?: number; minBooks?: number } = {},
): RoleCount[] {
  const min = opts.minBooks && opts.minBooks > 0 ? opts.minBooks : 1;
  const rows = [...counts]
    .map(([role, books]) => ({ role, books }))
    .filter((r) => r.books >= min)
    .sort((a, b) => (b.books !== a.books ? b.books - a.books : a.role.localeCompare(b.role)));
  return opts.limit && opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
}

export interface RoleBookMatch {
  id: string;
  title: string;
  author: string;
  authorId: string;
  ratings: number;
}

export interface RoleSummary {
  withRole: number;
  counts: Map<string, number>;
}

// One streaming pass over paren-carrying books (a LIKE prefilter keeps this off
// the multi-million-row full scan), O(distinct roles) memory — never loads books.
export function summarizeRoles(all = false): RoleSummary {
  const counts = new Map<string, number>();
  let withRole = 0;
  const stmt = getDb().prepare(`SELECT author FROM books WHERE author LIKE '%)%'`);
  for (const row of stmt.iterate() as IterableIterator<{ author: string }>) {
    const roles = selectRoles(row.author, all);
    if (roles.length === 0) continue;
    withRole++;
    for (const r of roles) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return { withRole, counts };
}

// Detail pass for one role. Books mode keeps only the first `limit` rows while
// still counting every match; authors mode aggregates per author_id (falling
// back to the author text when the id is absent) and ranks by book count.
export function collectRoleDetail(
  role: string,
  opts: { limit: number; authors?: boolean; all?: boolean },
): { total: number; authorTotal: number; books: RoleBookMatch[]; authors: Array<{ name: string; books: number }> } {
  const target = normalizeRole(role);
  const stmt = getDb().prepare(
    `SELECT id, title, author, author_id, ratings FROM books WHERE author LIKE '%)%'`,
  );
  let total = 0;
  const books: RoleBookMatch[] = [];
  const byAuthor = new Map<string, { name: string; books: number }>();
  for (const row of stmt.iterate() as IterableIterator<any>) {
    if (!selectRoles(row.author, opts.all).includes(target)) continue;
    total++;
    if (opts.authors) {
      const key = row.author_id || row.author;
      const hit = byAuthor.get(key);
      if (hit) hit.books++;
      else byAuthor.set(key, { name: String(row.author), books: 1 });
    } else if (books.length < opts.limit) {
      books.push({
        id: String(row.id),
        title: String(row.title),
        author: String(row.author),
        authorId: row.author_id ? String(row.author_id) : '',
        ratings: Number(row.ratings) || 0,
      });
    }
  }
  const authors = [...byAuthor.entries()]
    .map(([, v]) => v)
    .sort((a, b) => (b.books !== a.books ? b.books - a.books : a.name.localeCompare(b.name)))
    .slice(0, opts.limit);
  return { total, authorTotal: byAuthor.size, books, authors };
}

const oneLine = (s: string, width: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
};

const resolveInt = (v: string | number | undefined, fallback: number): number => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export async function runAuthorRoles(options: AuthorRolesOptions = {}): Promise<void> {
  const limit = resolveInt(options.limit, DEFAULT_ROLE_LIMIT);
  const minBooks = resolveInt(options.minBooks, 1);

  if (options.role) {
    const role = normalizeRole(options.role);
    const detail = collectRoleDetail(role, { limit, authors: options.authors, all: options.all });

    if (detail.total === 0) {
      console.log(chalk.yellow(`\n   No books carry the role "${role}" — try a plain report (no --role) to see the vocabulary${options.all ? '' : ' (or --all for unfiltered candidates)'}.`));
      return;
    }

    if (options.authors) {
      console.log(chalk.cyan.bold(`\n🎭 Authors credited as "${role}"`));
      console.log(chalk.gray(`   ${detail.total.toLocaleString()} books · ${detail.authorTotal.toLocaleString()} distinct authors${detail.authors.length < detail.authorTotal ? ` · top ${detail.authors.length.toLocaleString()} shown` : ''}`));
      console.log(chalk.gray('------------------------------------------'));
      detail.authors.forEach((a, i) => {
        console.log(`${(i + 1).toString().padStart(4, ' ')}. ${oneLine(a.name, 46).padEnd(47)} ${a.books.toLocaleString().padStart(6)} books`);
      });
      return;
    }

    console.log(chalk.cyan.bold(`\n🎭 Books credited with role "${role}"`));
    console.log(chalk.gray(`   ${detail.total.toLocaleString()} books total · showing first ${detail.books.length.toLocaleString()}`));
    console.log(chalk.gray('------------------------------------------'));
    detail.books.forEach((b, i) => {
      const title = oneLine(b.title, 58);
      const author = oneLine(b.author, 40);
      console.log(`${(i + 1).toString().padStart(4, ' ')}. ${b.id.padEnd(9)} ${title.padEnd(59)} ${b.ratings.toLocaleString().padStart(7)}★  ${chalk.gray(author)}`);
    });
    return;
  }

  // Summary: roles by book count.
  const started = Date.now();
  const { withRole, counts } = summarizeRoles(options.all);
  const ranked = rankRoleCounts(counts, { limit, minBooks });

  console.log(chalk.cyan.bold('\n🎭 Contributor roles in books.author'));
  console.log(chalk.gray(`   ${countBooks().toLocaleString()} books scanned · ${withRole.toLocaleString()} carry a role · ${counts.size.toLocaleString()} distinct roles${options.all ? ' (unfiltered candidates)' : ''} · min books: ${minBooks.toLocaleString()}`));
  console.log(chalk.gray('------------------------------------------'));

  if (ranked.length === 0) {
    console.log(chalk.yellow('   No roles match the criteria.'));
    return;
  }
  const max = ranked[0].books;
  ranked.forEach((r, i) => {
    const bar = '█'.repeat(Math.max(1, Math.round((r.books / max) * 20)));
    console.log(`${(i + 1).toString().padStart(4, ' ')}. ${r.role.padEnd(28, ' ')} ${r.books.toLocaleString().padStart(7)} ${chalk.gray(bar)}`);
  });
  console.log(chalk.gray(`------------------------------------------ · ${((Date.now() - started) / 1000).toFixed(1)}s`));
  console.log(chalk.gray('   Detail: --role <name> (books) · --role <name> --authors (authors credited) · --all (unfiltered candidates)'));
}
