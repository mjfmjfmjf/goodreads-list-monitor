import chalk from 'chalk';
import { getDb } from './db.ts';

export interface BooksWithoutWorkIdOptions {}

export async function runBooksWithoutWorkId(options: BooksWithoutWorkIdOptions = {}): Promise<void> {
  const db = getDb();
  
  const total = db.prepare("SELECT COUNT(*) as c FROM books WHERE work_id IS NULL OR work_id = ''").get() as any;
  console.log(chalk.cyan.bold('\n📊 Books without work_id'));
  console.log(chalk.gray('------------------------------------------'));
  console.log(`Total: ${total.c.toLocaleString()}`);
  
  // Ratings breakdown
  console.log(chalk.yellow.bold('\nRatings breakdown:'));
  const ratings = db.prepare(`
    SELECT 
      CASE 
        WHEN ratings IS NULL OR ratings = 0 OR ratings = '0' THEN '0'
        WHEN CAST(ratings AS INTEGER) BETWEEN 1 AND 10 THEN '1-10'
        WHEN CAST(ratings AS INTEGER) BETWEEN 11 AND 100 THEN '11-100'
        WHEN CAST(ratings AS INTEGER) BETWEEN 101 AND 1000 THEN '101-1000'
        WHEN CAST(ratings AS INTEGER) BETWEEN 1001 AND 10000 THEN '1001-10000'
        WHEN CAST(ratings AS INTEGER) BETWEEN 10001 AND 50000 THEN '10001-50000'
        WHEN CAST(ratings AS INTEGER) BETWEEN 50001 AND 100000 THEN '50001-100000'
        WHEN CAST(ratings AS INTEGER) BETWEEN 100001 AND 500000 THEN '100001-500000'
        WHEN CAST(ratings AS INTEGER) BETWEEN 500001 AND 1000000 THEN '500001-1000000'
        ELSE '1000000+'
      END as bucket,
      COUNT(*) as cnt
    FROM books 
    WHERE work_id IS NULL OR work_id = ''
    GROUP BY bucket
    ORDER BY 
      CASE bucket
        WHEN '0' THEN 1
        WHEN '1-10' THEN 2
        WHEN '11-100' THEN 3
        WHEN '101-1000' THEN 4
        WHEN '1001-10000' THEN 5
        WHEN '10001-50000' THEN 6
        WHEN '50001-100000' THEN 7
        WHEN '100001-500000' THEN 8
        WHEN '500001-1000000' THEN 9
        WHEN '1000000+' THEN 10
      END
  `).all() as any[];
  for (const r of ratings) {
    console.log(`  ${r.bucket.padEnd(15)}: ${r.cnt.toLocaleString()}`);
  }
  
  // Distinct authors
  const authors = db.prepare(`
    SELECT COUNT(DISTINCT author_id) as c 
    FROM books 
    WHERE (work_id IS NULL OR work_id = '') 
      AND author_id IS NOT NULL 
      AND author_id != ''
  `).get() as any;
  console.log(chalk.yellow.bold('\nDistinct authors (with author_id):'));
  console.log(`  ${authors.c.toLocaleString()}`);
  
  // Source field
  try {
    const sourceInfo = db.prepare(`
      SELECT source, COUNT(*) as cnt 
      FROM books 
      WHERE (work_id IS NULL OR work_id = '')
      GROUP BY source
      ORDER BY cnt DESC
    `).all() as any[];
    console.log(chalk.yellow.bold('\nSource breakdown:'));
    if (sourceInfo.length === 0) {
      console.log(`  (no source data)`);
    } else {
      for (const s of sourceInfo) {
        console.log(`  ${(s.source || '(null)').padEnd(30)}: ${s.cnt.toLocaleString()}`);
      }
    }
  } catch (e) {
    console.log(chalk.yellow.bold('\nSource breakdown:'));
    console.log(`  (source column not present on books)`);
  }
  
  // Date breakdown
  console.log(chalk.yellow.bold('\nFirst seen breakdown (last 30 days):'));
  const firstSeen = db.prepare(`
    SELECT 
      date(first_seen) as d,
      COUNT(*) as cnt
    FROM books 
    WHERE (work_id IS NULL OR work_id = '')
      AND first_seen IS NOT NULL
    GROUP BY date(first_seen)
    ORDER BY d DESC
    LIMIT 30
  `).all() as any[];
  for (const f of firstSeen) {
    console.log(`  ${f.d}: ${f.cnt.toLocaleString()}`);
  }
  
  console.log(chalk.yellow.bold('\nLast updated breakdown (last 30 days):'));
  const lastUpdated = db.prepare(`
    SELECT 
      date(last_updated) as d,
      COUNT(*) as cnt
    FROM books 
    WHERE (work_id IS NULL OR work_id = '')
      AND last_updated IS NOT NULL
    GROUP BY date(last_updated)
    ORDER BY d DESC
    LIMIT 30
  `).all() as any[];
  for (const l of lastUpdated) {
    console.log(`  ${l.d}: ${l.cnt.toLocaleString()}`);
  }
  
  console.log(chalk.gray('\n------------------------------------------'));
}
