import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { runAudit, AuditOptions } from './auditor.js';
import { ListEntry } from './tagConfig.js';

const DEFAULT_BULK_CONFIG_FILE = path.join(process.cwd(), 'bulkAuditConfig.json');

export async function runBulkAudit(customConfigFile?: string): Promise<void> {
  const configFile = customConfigFile ? path.resolve(process.cwd(), customConfigFile) : DEFAULT_BULK_CONFIG_FILE;

  if (!(await fs.pathExists(configFile))) {
    throw new Error(`Bulk audit config not found at: ${configFile}. Run "npm run gen-bulk-config" first or verify the file path.`);
  }

  const lists: ListEntry[] = await fs.readJson(configFile);
  console.log(chalk.cyan.bold(`\n🚀 Starting Bulk Audit for ${lists.length} lists using config: "${path.basename(configFile)}"\n`));

  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    const { min, max, minYear, maxYear, minAvg, maxAvg } = list.criteria;

    console.log(chalk.yellow.bold(`\n[${i + 1}/${lists.length}] List: "${list.officialTitle}" (ID: ${list.id})`));

    const auditOptions: AuditOptions = {};
    if (min !== undefined) auditOptions.min = min.toString();
    if (max !== undefined) auditOptions.max = max.toString();
    if (minYear !== undefined) auditOptions.minYear = minYear.toString();
    if (maxYear !== undefined) auditOptions.maxYear = maxYear.toString();
    if (minAvg !== undefined) auditOptions.minAvg = minAvg.toString();
    if (maxAvg !== undefined) auditOptions.maxAvg = maxAvg.toString();
    auditOptions.titleRegex = list.criteria.titleRegex;
    auditOptions.authorLastRegex = list.criteria.authorLastRegex;
    auditOptions.authorFirstRegex = list.criteria.authorFirstRegex;

    await runAudit(list.id, auditOptions);
  }

  console.log(chalk.cyan.bold('\n🏁 Bulk Audit process complete.'));
}
