import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { runAudit, AuditOptions, AuditResult } from './auditor.js';
import { ListEntry } from './tagConfig.js';
import { formatDuration } from './utils.js';

const DEFAULT_BULK_CONFIG_FILE = path.join(process.cwd(), 'bulkAuditConfig.json');

export async function runBulkAudit(customConfigFile?: string): Promise<void> {
  const configFile = customConfigFile ? path.resolve(process.cwd(), customConfigFile) : DEFAULT_BULK_CONFIG_FILE;

  if (!(await fs.pathExists(configFile))) {
    throw new Error(`Bulk audit config not found at: ${configFile}. Run "npm run gen-bulk-config" first or verify the file path.`);
  }

  const lists: ListEntry[] = await fs.readJson(configFile);
  const startedAt = new Date();
  console.log(chalk.cyan.bold(`\n🚀 Starting Bulk Audit for ${lists.length} lists using config: "${path.basename(configFile)}"`));
  console.log(chalk.gray(`   Started at: ${startedAt.toLocaleString()}\n`));

  const results: AuditResult[] = [];
  for (let i = 0; i < lists.length; i++) {
    const list = lists[i];
    const { min, max, minYear, maxYear, minAvg, maxAvg, seriesPos } = list.criteria;

    console.log(chalk.yellow.bold(`\n[${i + 1}/${lists.length}] List: "${list.officialTitle}" (ID: ${list.id})`));

    const auditOptions: AuditOptions = {};
    if (min !== undefined) auditOptions.min = min.toString();
    if (max !== undefined) auditOptions.max = max.toString();
    if (minYear !== undefined) auditOptions.minYear = minYear.toString();
    if (maxYear !== undefined) auditOptions.maxYear = maxYear.toString();
    if (minAvg !== undefined) auditOptions.minAvg = minAvg.toString();
    if (maxAvg !== undefined) auditOptions.maxAvg = maxAvg.toString();
    if (seriesPos !== undefined) auditOptions.seriesPos = seriesPos.toString();
    auditOptions.titleRegex = list.criteria.titleRegex;
    auditOptions.authorLastRegex = list.criteria.authorLastRegex;
    auditOptions.authorFirstRegex = list.criteria.authorFirstRegex;

    results.push(await runAudit(list.id, auditOptions));
  }

  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();

  console.log(chalk.cyan.bold('\n🏁 Bulk Audit process complete.'));

  const failedLists = results.filter(r => r.failed).length;
  const totalBooks = results.reduce((sum, r) => sum + r.totalBooks, 0);
  const totalOutliers = results.reduce((sum, r) => sum + r.outliers, 0);
  const tooManyRatings = results.reduce((sum, r) => sum + r.tooManyRatings, 0);
  const tooFewRatings = results.reduce((sum, r) => sum + r.tooFewRatings, 0);
  const tooEarly = results.reduce((sum, r) => sum + r.tooEarly, 0);
  const tooLate = results.reduce((sum, r) => sum + r.tooLate, 0);
  const tooLowAvg = results.reduce((sum, r) => sum + r.tooLowAvg, 0);
  const tooHighAvg = results.reduce((sum, r) => sum + r.tooHighAvg, 0);
  const regexMismatch = results.reduce((sum, r) => sum + r.regexMismatch, 0);
  const seriesPosMismatch = results.reduce((sum, r) => sum + r.seriesPosMismatch, 0);

  const breakdown: string[] = [];
  if (tooManyRatings > 0) breakdown.push(`${tooManyRatings} too many ratings`);
  if (tooFewRatings > 0) breakdown.push(`${tooFewRatings} too few ratings`);
  if (tooEarly > 0) breakdown.push(`${tooEarly} too early`);
  if (tooLate > 0) breakdown.push(`${tooLate} too late`);
  if (tooLowAvg > 0) breakdown.push(`${tooLowAvg} below avg rating`);
  if (tooHighAvg > 0) breakdown.push(`${tooHighAvg} above avg rating`);
  if (regexMismatch > 0) breakdown.push(`${regexMismatch} regex mismatches`);
  if (seriesPosMismatch > 0) breakdown.push(`${seriesPosMismatch} wrong series position`);

  console.log(chalk.cyan.bold('\n📊 Bulk Audit Summary'));
  console.log(chalk.gray(
    `   Read ${results.length} list${results.length === 1 ? '' : 's'} with ${totalBooks.toLocaleString()} book${totalBooks === 1 ? '' : 's'} and ${totalOutliers.toLocaleString()} outlier${totalOutliers === 1 ? '' : 's'}`
  ));
  if (breakdown.length > 0) {
    console.log(chalk.gray(`      of which ${breakdown.join(', ')}`));
  }
  if (failedLists > 0) {
    console.log(chalk.yellow(`   Failed lists: ${failedLists}`));
  }
  console.log(chalk.gray(`   Started: ${startedAt.toLocaleString()}`));
  console.log(chalk.gray(`   Ended:   ${endedAt.toLocaleString()}`));
  console.log(chalk.gray(`   Duration: ${formatDuration(durationMs)}`));
}
