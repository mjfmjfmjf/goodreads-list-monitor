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

    console.log(chalk.yellow.bold(`\n[${i + 1}/${lists.length}] List: "${list.officialTitle}" (ID: ${list.id})`));

    const auditOptions: AuditOptions = {};
    if (min !== undefined) auditOptions.min = min.toString();
    if (max !== undefined) auditOptions.max = max.toString();
    if (minYear !== undefined) auditOptions.minYear = minYear.toString();
    if (maxYear !== undefined) auditOptions.maxYear = maxYear.toString();

    await runAudit(list.id, auditOptions);
  }

  console.log(chalk.cyan.bold('\n🏁 Bulk Audit process complete.'));
}
