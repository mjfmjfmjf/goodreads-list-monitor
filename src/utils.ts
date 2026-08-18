import chalk from 'chalk';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

export async function delay(min = 100, max = 2000): Promise<void> {
  const adjMin = min * 1.5;
  const adjMax = max * 1.5;
  const ms = Math.floor(Math.random() * (adjMax - adjMin + 1) + adjMin) + 100;
  console.log(chalk.gray(`   (Waiting ${(ms / 1000).toFixed(2)}s...)`));
  return new Promise(resolve => setTimeout(resolve, ms));
}

const STRICT_THROTTLE_MODE = (): boolean => process.env.GOODREADS_STRICT_THROTTLE === '1';

export async function fetchWithRetry(url: string, config: AxiosRequestConfig, retries = 5): Promise<AxiosResponse> {
  let lastError: any;
  
  for (let i = 0; i < retries; i++) {
    try {
      if (i > 0) {
        const waitTime = Math.pow(2, i) * 3000; // 3s, 6s, 12s backoff
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }

      // Add a small 100ms safety sleep right before the call
      await new Promise(resolve => setTimeout(resolve, 100));

      const response = await axios.get(url, config);
      
      // Treat 202 as a retryable error
      if (response.status === 202) {
        // Strict mode (used by integration tests): give up immediately on
        // throttling instead of burning time on backoff retries.
        if (STRICT_THROTTLE_MODE()) {
          throw new Error('Goodreads throttled (HTTP 202 interstitial) — strict mode, giving up immediately. Retry the suite after a cooldown.');
        }
        throw { 
          response: response, 
          message: 'Received 202 (Accepted) interstitial',
          isRetryable: true 
        };
      }
      
      return response;
    } catch (error: any) {
      lastError = error;
      const status = error.response?.status;
      
      if (status === 429) {
        console.log(chalk.red.bold(`   🛑 Rate limited (Status 429). Giving up to avoid further blocking.`));
        throw error;
      }

      // Anti-bot throttling (403) or 429 in strict mode: hard give up, no retry.
      if (STRICT_THROTTLE_MODE() && (status === 403 || status === 429)) {
        throw new Error(`Goodreads throttled (HTTP ${status}) — strict mode, giving up immediately. Retry the suite after a cooldown.`);
      }

      // Retry on 5xx (Server Errors), 202 interstitials, or timeouts
      const isRetryable = (status >= 500 && status <= 599) || error.code === 'ECONNABORTED' || error.isRetryable;
      
      if (isRetryable) {
        continue;
      }
      
      // Don't retry on 404 or other 4xx errors
      throw error;
    }
  }
  
  throw lastError;
}

export function getYear(dateString: string): number | null {
  if (!dateString || dateString === 'Unknown') return null;
  
  // 1. Handle our custom YYYY.MM.DD format
  if (/^\d{1,4}\.\d{2}\.\d{2}$/.test(dateString)) {
    return parseInt(dateString.split('.')[0], 10);
  }

  // 2. Handle a plain 1-4 digit year
  if (/^\d{1,4}$/.test(dateString)) {
    return parseInt(dateString, 10);
  }

  // 3. Look for a 4-digit year in a larger string (e.g. "January 1, 2008")
  const match = dateString.match(/\b(\d{4})\b/);
  if (match) {
    const y = parseInt(match[1], 10);
    if (y <= 2100) return y;
  }

  return null;
}

export function formatDate(dateString: string, context?: string): string {
  if (!dateString || dateString === 'Unknown') return 'Unknown';

  const cleanStr = dateString.replace(/First published |Published /gi, '').trim();

  // 1. If it's just a year, return it
  if (/^\d{1,4}$/.test(cleanStr)) return cleanStr;

  // 2. Try standard date parsing
  const date = new Date(cleanStr);
  if (!isNaN(date.getTime())) {
    const y = date.getFullYear();
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const d = date.getDate().toString().padStart(2, '0');
    
    const fourDigitMatch = cleanStr.match(/\b(\d{4})\b/);
    const anyDigitMatch = cleanStr.match(/\b(\d{1,4})\b/);
    
    let actualYear = y;
    if (fourDigitMatch) {
      actualYear = parseInt(fourDigitMatch[1], 10);
    } else if (anyDigitMatch && y < 100) {
      actualYear = parseInt(anyDigitMatch[1], 10);
      console.log(chalk.yellow(`   ⚠️ Warning: Ambiguous year "${y}" for "${context || dateString}". Guessing "${actualYear}".`));
    }
    
    return `${actualYear}.${m}.${d}`;
  }

  // 3. SURGICAL FALLBACK: If new Date() failed (e.g. "PaperbackAugust 7, 2003"), 
  // try to find a Month Day, Year pattern manually
  const months = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  const manualMatch = cleanStr.match(new RegExp(`${months}\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'));
  
  if (manualMatch) {
    const monthName = manualMatch[1];
    const day = manualMatch[2].padStart(2, '0');
    const year = manualMatch[3];
    
    const monthIndex = new Date(`${monthName} 1, 2000`).getMonth() + 1;
    const month = monthIndex.toString().padStart(2, '0');
    
    return `${year}.${month}.${day}`;
  }

  // 4. Final attempt: Just return a 4-digit year if found
  const yearOnly = getYear(cleanStr);
  if (yearOnly) {
    console.log(chalk.yellow(`   ⚠️ Warning: Falling back to year-only "${yearOnly}" for "${context || dateString}" (Raw: "${cleanStr}")`));
    return yearOnly.toString();
  }

  return 'Unknown';
}


export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s*\(.*\)$/, '')      // Remove anything in parentheses at the end (e.g. (Paperback))
    .replace(/\s*#\d+/, '')         // Remove volume numbers like #1
    .replace(/:\s+.*$/, '')         // Remove subtitles after a colon (e.g. "Dune: 50th Anniversary")
    .replace(/[^a-z0-9\s]/g, '')    // Remove punctuation
    .replace(/\s+/g, ' ')           // Normalize whitespace
    .trim();
}

export function stripTitleSuffix(title: string): string {
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

export function normalizeAuthor(author: string): string {
  return author
    .toLowerCase()
    .replace(/\(.*\)$/, '')         // Remove roles like (Goodreads Author) or (Contributor)
    .replace(/[^a-z0-9\s]/g, '')    // Remove punctuation
    .replace(/\s+/g, ' ')           // Normalize whitespace
    .trim();
}

export function formatBookLink(title: string, id: string): string {
  // The [book:Title|ID] link format uses [ ], and | as syntax, so strip any of
  // those from the title itself. Otherwise titles like "約束のネバーランド 19
  // [Yakusoku no Neverland 19]" produce a broken-looking nested-bracket link.
  const cleanTitle = title.replace(/[\[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
  return `[book:${cleanTitle}|${id}]`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
