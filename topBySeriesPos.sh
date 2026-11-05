#!/bin/bash
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  echo "Usage: ./topBySeriesPos.sh --position <n> [--limit <n>]"
  exit 0
fi
date
echo "starting topBySeriesPos.sh"
NODE_OPTIONS='--loader ts-node/esm --no-warnings' node << 'SCRIPT'
import { iterateBooks } from './src/storage.ts';
import { parseSeriesPos, SERIES_POS_MULTI } from './src/seriesPos.ts';
import chalk from 'chalk';

const args = process.argv.slice(1);
let pos = 1;
let limit = 50;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--position' && args[i+1]) pos = parseFloat(args[i+1]);
  if (args[i] === '--limit' && args[i+1]) limit = parseInt(args[i+1]);
}

const books = [];
for (const book of iterateBooks()) {
  const bpos = parseSeriesPos(book.title) ?? book.seriesPos;
  if (bpos !== undefined && bpos !== SERIES_POS_MULTI && Math.abs(bpos - pos) < 0.001) {
    books.push(book);
  }
}

books.sort((a, b) => {
  const ra = parseInt(String(a.ratings || '0').replace(/,/g, ''), 10) || 0;
  const rb = parseInt(String(b.ratings || '0').replace(/,/g, ''), 10) || 0;
  if (rb !== ra) return rb - ra;
  const aa = typeof a.avgRating === 'number' ? a.avgRating : parseFloat(String(a.avgRating));
  const ab = typeof b.avgRating === 'number' ? b.avgRating : parseFloat(String(b.avgRating));
  return (isNaN(ab)?0:ab) - (isNaN(aa)?0:aa);
});

console.log(chalk.cyan.bold(`\n🏆 Top books at series position ${pos}`));
console.log(chalk.gray(`   Found ${books.length.toLocaleString()} books | Showing top ${Math.min(limit, books.length)}`));
console.log(chalk.gray('------------------------------------------'));

for (let i = 0; i < Math.min(limit, books.length); i++) {
  const b = books[i];
  const r = parseInt(String(b.ratings || '0').replace(/,/g, ''), 10) || 0;
  const aa = typeof b.avgRating === 'number' ? b.avgRating : parseFloat(String(b.avgRating));
  const a = !isNaN(aa) ? aa.toFixed(2) : 'N/A';
  console.log(
    `${(i + 1).toString().padStart(4, ' ')}. ${chalk.green(r.toLocaleString())} ratings (${a}★) - [book:${b.title}${b.author ? ' by ' + b.author : ''}|${b.id}]`
  );
}

console.log(chalk.gray('------------------------------------------'));
SCRIPT
echo "ended topBySeriesPos.sh"
date
