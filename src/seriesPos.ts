// Series position parsing from book titles.
//
// Phase 1: general book form — the "(Series Name, #N)" suffix Goodreads uses,
// e.g. "Oathbringer (The Stormlight Archive, #3)". A book with no series marker
// is a standalone (no seriesPos).
//
// Phase 2: manga "Vol. N" / "Volume N" form, e.g. "Berserk, Vol. 12" and
// "One Piece, Volume 23: Vivi's Adventure".
//
// Phase 3: manga volume-in-title (double-bang) form, e.g.
// "ハイキュー!! 4 [Haikyū!! 4]".

export const SERIES_POS_MULTI = 99.99;
export const SERIES_POS_STANDALONE = -1;

const MARKER = /#\s*(\d+(?:\.\d+)?)/g;
const RANGE = /#\s*\d+(?:\.\d+)?\s*-\s*#?\s*\d+(?:\.\d+)?/;

const VOL_RE = /\b(?:volumes?|vol\.?)\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/gi;
const DOUBLE_BANG_RE = /!!\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/i;

// Returns a numeric series position parsed from a title, SERIES_POS_MULTI when
// the title indicates a multi-volume collection (e.g. "#1-3, 5, 7-8"), or
// undefined for standalone books / titles without a parseable marker.
export function parseSeriesPos(title: string): number | undefined {
  if (!title) return undefined;

  return (
    parseGeneralSeriesPos(title) ??
    parseMangaVolSeriesPos(title) ??
    parseMangaDoubleBangSeriesPos(title)
  );
}

function parseGeneralSeriesPos(title: string): number | undefined {
  // A range like "#1-3" or "#1-#7" means a collected/multi-volume boxed set.
  if (RANGE.test(title)) return SERIES_POS_MULTI;

  const markers: number[] = [];
  let match: RegExpExecArray | null;
  MARKER.lastIndex = 0;
  while ((match = MARKER.exec(title)) !== null) {
    markers.push(parseFloat(match[1]));
  }

  if (markers.length === 0) return undefined;

  // Multiple distinct markers ("(Series A, #5) (Series B, #3)" or
  // "(Discworld, #1; Rincewind, #1)") mean a single book in multiple series,
  // NOT a boxed set — use the first marker's position.
  return markers[0];
}

function parseMangaVolSeriesPos(title: string): number | undefined {
  const matches = Array.from(title.matchAll(VOL_RE));
  if (matches.length === 0) return undefined;

  // A range like "Vol. 12-14" (omnibus) or repeated markers mean multi-volume.
  if (matches.length > 1 || matches.some((m) => m[2] !== undefined)) {
    return SERIES_POS_MULTI;
  }
  return parseFloat(matches[0][1]);
}

function parseMangaDoubleBangSeriesPos(title: string): number | undefined {
  const match = title.match(DOUBLE_BANG_RE);
  if (!match) return undefined;

  // A range like "ハイキュー!! 1-3" means a multi-volume collection. Note the
  // title may repeat the volume in brackets ("[Haikyū!! 4]"), so only the first
  // match is used and repeated markers are NOT treated as multi-volume here.
  if (match[2] !== undefined) return SERIES_POS_MULTI;
  return parseFloat(match[1]);
}

// Equality match used by audits. SERIES_POS_STANDALONE (-1) means "no series
// position" and matches books whose seriesPos is undefined.
export function matchesSeriesPos(target: number, actual: number | undefined): boolean {
  if (target === SERIES_POS_STANDALONE) return actual === undefined;
  return actual === target;
}
