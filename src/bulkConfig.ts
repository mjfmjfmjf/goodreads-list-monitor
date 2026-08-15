import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { loadState, loadBookCache } from './storage.js';
import { TagConfig, ListEntry, AuditCriteria } from './tagConfig.js';
import { SERIES_POS_STANDALONE } from './seriesPos.js';

const BULK_CONFIG_FILE = path.join(process.cwd(), 'bulkAuditConfig.json');

export async function generateBulkConfig(): Promise<void> {
  console.log(chalk.cyan.bold('🚀 Generating Bulk Audit Configuration (Smart Merge)...'));
  
  const state = await loadState();
  const allLists: Map<string, ListEntry> = new Map();

  // 0. Load existing config to preserve manual edits
  if (await fs.pathExists(BULK_CONFIG_FILE)) {
    const existingConfig: ListEntry[] = await fs.readJson(BULK_CONFIG_FILE);
    for (const entry of existingConfig) {
      allLists.set(entry.id, entry);
    }
    console.log(chalk.gray(`   Loaded ${allLists.size} existing entries to preserve edits.`));
  }

  // 1. Add lists from existing tag configs (if not already in map)
  const tagFiles = ['science-fiction.json', 'to-read.json'];
  for (const file of tagFiles) {
    const filePath = path.join(process.cwd(), 'tags', file);
    if (await fs.pathExists(filePath)) {
      const config: TagConfig = await fs.readJson(filePath);
      for (const list of config.lists) {
        if (!allLists.has(list.id)) {
           allLists.set(list.id, list);
        }
      }
    }
  }

  // 2. Add lists from user state (Discovery)
  for (const [id, l] of Object.entries(state.lists)) {
    if (!allLists.has(id)) {
      const criteria = parseCriteriaFromName(l.title);
      allLists.set(id, {
        id,
        nickname: l.title.split(':')[0].substring(0, 20),
        officialTitle: l.title,
        url: l.url || `https://www.goodreads.com/list/show/${id}`,
        criteria
      });
    }
  }

  // 3. Sort lists (by title, then ID)
  const sortedLists = Array.from(allLists.values()).sort((a, b) => {
    return a.officialTitle.localeCompare(b.officialTitle) || a.id.localeCompare(b.id);
  });

  await fs.writeJson(BULK_CONFIG_FILE, sortedLists, { spaces: 2 });
  console.log(chalk.green.bold(`✅ Bulk configuration saved to ${BULK_CONFIG_FILE}`));
  console.log(chalk.gray(`   Total unique lists: ${sortedLists.length}`));
}

function parseCriteriaFromName(title: string): AuditCriteria {
  const cleanTitle = title.toLowerCase().replace(/,/g, '').replace(/'/g, '');
  const criteria: AuditCriteria = {};

  // 1. Ratings
  if (cleanTitle.includes('and more')) {
    const match = cleanTitle.match(/(\d+)/);
    if (match) criteria.min = parseInt(match[1], 10);
  } else if (cleanTitle.includes('less than')) {
    const match = cleanTitle.match(/(\d+)/);
    if (match) criteria.max = parseInt(match[1], 10);
  } else if (cleanTitle.includes('between')) {
    const match = cleanTitle.match(/between ([\d,]+) and ([\d,]+)/);
    if (match) {
        criteria.min = parseInt(match[1], 10);
        criteria.max = parseInt(match[2], 10);
    }
  }

  // 2. Year/Decade Logic
  // a. Check for full decades (e.g., "1960s")
  const fullDecadeMatch = cleanTitle.match(/\b(18|19|20)(\d)0s\b/);
  if (fullDecadeMatch) {
    const startYear = parseInt(fullDecadeMatch[1] + fullDecadeMatch[2] + '0', 10);
    criteria.minYear = startYear;
    criteria.maxYear = startYear + 9;
    return criteria;
  }

  // b. Check for short decades (e.g., "30s", "of the 30's")
  const shortDecadeMatch = cleanTitle.match(/\b(\d)0s\b/);
  if (shortDecadeMatch) {
    const startYear = parseInt('19' + shortDecadeMatch[1] + '0', 10);
    criteria.minYear = startYear;
    criteria.maxYear = startYear + 9;
    return criteria;
  }

  // c. Check for specific release years (e.g., "released in 2023")
  const yearMatch = cleanTitle.match(/\b(released in|published in|of)\s+(\d{4})\b/);
  if (yearMatch) {
    const year = parseInt(yearMatch[2], 10);
    criteria.minYear = year;
    criteria.maxYear = year;
    return criteria;
  }

  // d. Check for Centuries (e.g., "20th Century")
  const centuryMatch = cleanTitle.match(/\b(\d{2})(st|nd|rd|th)\s+century\b/);
  if (centuryMatch) {
    const century = parseInt(centuryMatch[1], 10);
    criteria.minYear = (century - 1) * 100;
    criteria.maxYear = criteria.minYear + 99;
    return criteria;
  }

  // 3. Series Position (e.g., "Series Position 1", "Position 3.5", "Standalone")
  const positionMatch = cleanTitle.match(/position\s+([\d.]+)/);
  if (positionMatch) {
    criteria.seriesPos = parseFloat(positionMatch[1]);
    return criteria;
  }
  if (/stand\s*-?\s*alone/.test(cleanTitle)) {
    criteria.seriesPos = SERIES_POS_STANDALONE;
    return criteria;
  }

  return criteria;
}
