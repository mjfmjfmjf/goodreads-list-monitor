import chalk from 'chalk';

console.log('\n🎨 ' + chalk.bold('Goodreads Monitor Bright Palette') + '\n');

console.log(chalk.cyan.bold('■ Cyan') + '    - ' + chalk.cyan.bold('Action headers, start/end messages, and total timers.'));
console.log(chalk.green.bold('■ Green') + '   - ' + chalk.green.bold('Missing books found, successful additions, and completion checkmarks.'));
console.log(chalk.magenta.bold('■ Magenta') + ' - ' + chalk.magenta.bold('Detailed "ADDED" alerts and "Graduated" messages.'));
console.log(chalk.yellow.bold('■ Yellow') + '  - ' + chalk.yellow.bold('Alerts for count changes, audit progress counters, and warnings.'));
console.log(chalk.red.bold('■ Red') + '     - ' + chalk.red.bold('Removed books, outliers that fail criteria, and fatal errors.'));
console.log(chalk.white.bold('■ White') + '   - ' + chalk.white.bold('List nicknames in final summaries.'));
console.log(chalk.gray('■ Gray') + '    - ' + chalk.gray('Background details (waiting/delays, status codes, and item counts).'));
console.log('');
