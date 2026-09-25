type Level = 'info' | 'warn' | 'error';

function write(level: Level, scope: string, message: string, err?: unknown): void {
  const detail = err instanceof Error ? ` | ${err.stack ?? err.message}` : err !== undefined ? ` | ${String(err)}` : '';
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}${detail}\n`;
  (level === 'info' ? process.stdout : process.stderr).write(line);
}

export const logger = {
  info: (scope: string, message: string) => write('info', scope, message),
  warn: (scope: string, message: string, err?: unknown) => write('warn', scope, message, err),
  error: (scope: string, message: string, err?: unknown) => write('error', scope, message, err),
};
