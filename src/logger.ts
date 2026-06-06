import fs from 'fs-extra';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'changeLog.txt');

export async function appendToLog(message: string): Promise<void> {
  const timestamp = new Date().toLocaleString();
  const logEntry = `[${timestamp}] ${message}\n`;
  await fs.appendFile(LOG_FILE, logEntry);
}
