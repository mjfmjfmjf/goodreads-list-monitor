// Pure parsing helpers for the /book/show page HTML (SSR apollo payload +
// rendered-DOM extras). Kept free of network/DB side effects so they can be
// unit-tested offline. Shapes below were verified against live pages (2026/09).

// Genres listed in the site-wide nav on every Goodreads page — not book-specific.
const NAV_GENRES = new Set([
  'Biography', 'Book Club', 'Fantasy', 'Food',
  'Graphic Novels', 'History', 'Nonfiction', 'Science', 'Science Fiction'
]);

export function extractNextDataJson(html: string): string | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}

function firstNonNull<T>(...vals: (T | null | undefined)[]): T | undefined {
  for (const v of vals) if (v !== null && v !== undefined) return v;
  return undefined;
}

export interface SocialSignals {
  currentlyReading?: number;
  toRead?: number;
}

// `getSocialSignals` lives on ROOT_QUERY as a field whose value is an array of
// SocialSignal objects ({name, count, shelfPhrase, userPhrase, users}).
export function parseSocialSignals(html: string): SocialSignals {
  const json = extractNextDataJson(html);
  if (!json) return {};
  let nextData: any;
  try {
    nextData = JSON.parse(json);
  } catch {
    return {};
  }
  const apolloState = nextData?.props?.pageProps?.apolloState || {};
  const root = apolloState.ROOT_QUERY || {};
  const signals: SocialSignals = {};
  for (const value of Object.values(root)) {
    const arr = value as any;
    if (!arr || !Array.isArray(arr)) continue;
    for (const s of arr) {
      if (!s || s.__typename !== 'SocialSignal' || typeof s.name !== 'string') continue;
      const count = typeof s.count === 'number' ? s.count : undefined;
      if (s.name === 'CURRENTLY_READING' && count !== undefined) signals.currentlyReading = count;
      if (s.name === 'TO_READ' && count !== undefined) signals.toRead = count;
    }
  }
  return signals;
}

// Logged-in rendered DOM shows "Show all 886 editions" (non-breaking spaces
// possible) inside the Book details control. Not present in the SSR payload.
export function extractEditionsCount(html: string): number | undefined {
  const clean = html.replace(/\u00a0/g, ' ');
  const primary = clean.match(/(?:Show|See)\s+(?:all\s+)?([\d,]+)\s+editions?/i);
  const fallback = clean.match(/\b([\d,]{2,})\s+editions?\b/i);
  const match = primary ?? fallback;
  if (!match) return undefined;
  const n = parseInt(match[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : undefined;
}

export interface BookPageDetails {
  genres: string[];
  ratings?: string;
  avgRating?: string;
  reviewsCount?: string;
  ratingsCountDist?: Record<string, number> | null;
  published?: string;
  pages?: string;
  publisher?: string;
  isbn?: string;
  isbn13?: string;
  asin?: string;
  format?: string;
  language?: string;
  description?: string;
  series: { title: string; position?: string }[];
  workId?: string;
}

function deref(apolloState: any, ref: any): any {
  if (!ref) return null;
  if (typeof ref === 'string') return apolloState[ref] ?? null;
  if (typeof ref === 'object' && typeof ref.__ref === 'string') return apolloState[ref.__ref] ?? null;
  return ref; // inline object
}

function formatPublished(ts: string | number): string | undefined {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return undefined;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}.${m}.${d}`;
}

export function parseBookPageFromHtml(html: string, bookId: string): BookPageDetails {
  const empty: BookPageDetails = { genres: [], series: [] };
  const json = extractNextDataJson(html);
  if (!json) return empty;
  let nextData: any;
  try {
    nextData = JSON.parse(json);
  } catch {
    return empty;
  }
  const apolloState = nextData?.props?.pageProps?.apolloState || {};
  const idNum = /^\d+$/.test(bookId) ? parseInt(bookId, 10) : bookId;
  const bookKey = Object.keys(apolloState).find(k => {
    if (!k.startsWith('Book:')) return false;
    const bd = apolloState[k];
    return bd && (bd.legacyId === idNum || String(bd.legacyId) === bookId);
  });
  const bookData = bookKey ? apolloState[bookKey] : null;
  if (!bookData) return empty;

  const genres: string[] = [];
  if (Array.isArray(bookData.bookGenres)) {
    for (const bg of bookData.bookGenres) {
      const genre = deref(apolloState, bg?.genre);
      const name = typeof genre?.name === 'string' ? genre.name : undefined;
      if (name) genres.push(name);
    }
  }
  const out: BookPageDetails = {
    genres: [...new Set(genres)].filter(g => !NAV_GENRES.has(g)),
    series: [],
  };

  const stats = firstNonNull(
    deref(apolloState, bookData.stats),
    bookData.work ? deref(apolloState, bookData.work)?.stats ?? deref(apolloState, bookData.work) : undefined,
  ) ?? bookData.stats;
  const statsObj = stats && stats.ratingsCount !== undefined ? stats : null;
  if (statsObj) {
    out.ratings = statsObj.ratingsCount.toLocaleString('en-US');
    if (statsObj.averageRating !== undefined) out.avgRating = String(Number(statsObj.averageRating).toFixed(2));
    if (statsObj.textReviewsCount !== undefined) out.reviewsCount = statsObj.textReviewsCount.toLocaleString('en-US');
    const dist = statsObj.ratingsCountDist;
    if (Array.isArray(dist)) {
      const rec: Record<string, number> = {};
      dist.forEach((n, i) => { if (typeof n === 'number') rec[String(i + 1)] = n; });
      out.ratingsCountDist = Object.keys(rec).length ? rec : null;
    } else if (dist && typeof dist === 'object') {
      out.ratingsCountDist = dist;
    }
  }

  const workData = bookData.work ? deref(apolloState, bookData.work) : null;
  const workDetails = workData?.details ? deref(apolloState, workData.details) : null;
  const details = bookData.details ? deref(apolloState, bookData.details) : null;

  const pubTs = firstNonNull(workDetails?.publicationTime, details?.publicationTime);
  if (pubTs !== undefined && pubTs !== null) out.published = formatPublished(pubTs);

  const detailSrc = details ?? workDetails;
  if (detailSrc) {
    if (detailSrc.numPages !== undefined && detailSrc.numPages !== null) out.pages = String(detailSrc.numPages);
    if (typeof detailSrc.publisher === 'string') out.publisher = detailSrc.publisher;
    if (typeof detailSrc.isbn === 'string') out.isbn = detailSrc.isbn;
    if (typeof detailSrc.isbn13 === 'string') out.isbn13 = detailSrc.isbn13;
    if (typeof detailSrc.asin === 'string') out.asin = detailSrc.asin;
    if (typeof detailSrc.format === 'string') out.format = detailSrc.format;
    const lang = deref(apolloState, detailSrc.language);
    if (typeof lang?.name === 'string') out.language = lang.name;
  }

  const desc = firstNonNull(bookData['description({"stripped":true})'], bookData.description);
  if (typeof desc === 'string' && desc.trim()) out.description = desc.trim();

  if (Array.isArray(bookData.bookSeries)) {
    for (const bs of bookData.bookSeries) {
      const series = deref(apolloState, bs?.series);
      if (typeof series?.title === 'string') {
        out.series.push({ title: series.title, position: bs?.position !== undefined ? String(bs.position) : undefined });
      }
    }
  }

  const workMatch = html.match(/work\/editions\/(\d+)/);
  if (workMatch) out.workId = workMatch[1];

  return out;
}

export type FetchClass = 'ok' | 'throttled' | 'missing' | 'error';

export interface FetchClassifyInput {
  httpStatus?: number;
  bytes?: number;
  html?: string;
  networkError?: boolean;
}

export function classifyBookFetch(input: FetchClassifyInput): FetchClass {
  if (input.networkError) return 'error';
  const status = input.httpStatus;
  const bytes = input.bytes ?? 0;
  if (status === 202 || status === 403 || status === 429) return 'throttled';
  if (status === 404) return 'missing';
  if (status === 200) {
    if (bytes >= 1000 && input.html && extractNextDataJson(input.html)) return 'ok';
    return 'error'; // truncated/interstitial page that still returned 200
  }
  return 'error';
}

export interface CandidateQueryOptions {
  skipHas?: string | string[];
  minRatings?: number;
  sort: string;
  limit: number;
}

const SKIP_CRITERIA: Record<string, string> = {
  genres: `(genres IS NULL OR genres = '' OR genres = '[]' OR genres = 'null')`,
  'work-id': `(work_id IS NULL OR work_id = '')`,
  tags: `(tags IS NULL OR tags = '' OR tags = '{}' OR tags = 'null')`,
};

const SORT_ORDERS: Record<string, string> = {
  ratingsDesc: 'ratings DESC, id ASC',
  ratingsAsc: 'ratings ASC, id ASC',
  random: 'RANDOM()',
};

export function buildCandidateQuery(opts: CandidateQueryOptions): { sql: string; params: any[] } {
  const skipList = (opts.skipHas === undefined ? [] : Array.isArray(opts.skipHas) ? opts.skipHas : [opts.skipHas])
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const where: string[] = ['is_bad = 0', 'requires_auth = 0'];
  const params: any[] = [];
  for (const criterion of skipList) {
    const cond = SKIP_CRITERIA[criterion];
    if (!cond) throw new Error(`Unknown --skip-has criterion: "${criterion}" (expected genres|work-id|tags)`);
    where.push(cond);
  }
  const order = SORT_ORDERS[opts.sort];
  if (!order) throw new Error(`Unknown --sort "${opts.sort}" (expected ratingsDesc|ratingsAsc|random)`);
  if (opts.minRatings !== undefined) {
    where.push('ratings >= ?');
    params.push(Number(opts.minRatings));
  }
  const sql = `SELECT id, title, author, ratings FROM books WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`;
  params.push(Number(opts.limit));
  return { sql, params };
}