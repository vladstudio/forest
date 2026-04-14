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
  private writeQueue = Promise.resolve();
  private writeCount = 0;

  constructor() {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    this.fd = fs.openSync(LOG_PATH, 'a');
  }

  private enqueue(level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        const buf = Buffer.from(line);
        await new Promise<void>((resolve, reject) =>
          fs.write(this.fd, buf, 0, buf.length, null, (err) => err ? reject(err) : resolve()),
        );
        if (++this.writeCount % 100 === 0) await this.rotate();
      } catch { /* best-effort */ }
    });
  }

  private async rotate(): Promise<void> {
    try {
      const stat = fs.fstatSync(this.fd);
      if (stat.size > MAX_SIZE) {
        const backup = LOG_PATH + '.1';
        try { fs.unlinkSync(backup); } catch {}
        fs.renameSync(LOG_PATH, backup);
        const newFd = fs.openSync(LOG_PATH, 'a');
        fs.closeSync(this.fd);
        this.fd = newFd;
      }
    } catch {}
  }

  info(msg: string): void { this.enqueue('INFO', msg); }
  warn(msg: string): void { this.enqueue('WARN', msg); }
  error(msg: string): void { this.enqueue('ERROR', msg); }

  dispose(): void {
    this.writeQueue.then(() => {
      try { fs.closeSync(this.fd); } catch {}
    });
  }
}

export function initLogger(): Logger {
  const logger = new Logger();
  log.info = (msg) => logger.info(msg);
  log.warn = (msg) => logger.warn(msg);
  log.error = (msg) => logger.error(msg);
  return logger;
}
