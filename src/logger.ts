import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOG_PATH = path.join(os.homedir(), '.forest', 'forest.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

type LogFn = (msg: string) => void;

export const log = {
  info: (() => {}) as LogFn,
  warn: (() => {}) as LogFn,
  error: (() => {}) as LogFn,
};

export class Logger {
  private fd: number;

  constructor() {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    this.fd = fs.openSync(LOG_PATH, 'a');
  }

  private write(level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    try {
      fs.writeSync(this.fd, line);
      this.rotate();
    } catch {}
  }

  private rotate(): void {
    try {
      const stat = fs.fstatSync(this.fd);
      if (stat.size > MAX_SIZE) {
        fs.closeSync(this.fd);
        const backup = LOG_PATH + '.1';
        try { fs.unlinkSync(backup); } catch {}
        fs.renameSync(LOG_PATH, backup);
        this.fd = fs.openSync(LOG_PATH, 'a');
      }
    } catch {}
  }

  info(msg: string): void { this.write('INFO', msg); }
  warn(msg: string): void { this.write('WARN', msg); }
  error(msg: string): void { this.write('ERROR', msg); }

  dispose(): void {
    try { fs.closeSync(this.fd); } catch {}
  }
}

export function initLogger(): Logger {
  const logger = new Logger();
  log.info = (msg) => logger.info(msg);
  log.warn = (msg) => logger.warn(msg);
  log.error = (msg) => logger.error(msg);
  return logger;
}
