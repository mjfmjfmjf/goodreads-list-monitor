import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { runAudit, AuditOptions } from './auditor.js';
import { ListEntry } from './tagConfig.js';

const BULK_CONFIG_FILE = path.join(process.cwd(), 'bulkAuditConfig.json');

export async function runBulkAudit(): Promise<void> {
  if (!(await fs.pathExists(BULK_CONFIG_FILE))) {
    throw new Error('Bulk audit config not found. Run "npm run gen-bulk-config" first.');
  }

  const lists: ListEntry[] = await fs.readJson(BULK_CONFIG_FILE);
  console.log(chalk.cyan.bold(`\n🚀 Starting Bulk Audit for ${lists.length} lists...\n`));

  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    const { min, max, minYear, maxYear } = list.criteria;
    
    const hasRatings = min !== undefined || max !== undefined;
    const hasYear = minYear !== undefined || maxYear !== undefined;

    console.log(chalk.yellow.bold(`\n[${i + 1}/${lists.length}] List: "${list.officialTitle}" (ID: ${list.id})`));

    if (!hasRatings && !hasYear) {
      console.log(chalk.gray(`   ⏩ Skipping: No criteria defined for this list.`));
      continue;
    }

    // 1. PERFORM YEAR AUDIT (If applicable)
    if (hasYear) {
      console.log(chalk.cyan.bold(`   📅 Running Year Audit...`));
      await runAudit(list.id, { 
        minYear: minYear?.toString(), 
        maxYear: maxYear?.toString() 
      });
    }

    // 2. PERFORM RATINGS AUDIT (If applicable)
    if (hasRatings) {
      console.log(chalk.cyan.bold(`   ⭐ Running Ratings Audit...`));
      await runAudit(list.id, { 
        min: min?.toString(), 
        max: max?.toString() 
      });
    }
  }

  console.log(chalk.cyan.bold('\n🏁 Bulk Audit process complete.'));
}
