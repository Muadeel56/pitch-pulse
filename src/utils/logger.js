// A tiny leveled logger for a long-running server. `debug` only prints when
// LOG_LEVEL=debug is set — no CLI arg-parsing entrypoint here to toggle it at
// runtime, so it's env-driven (12-factor config) rather than a setter.
//
// Raw ANSI escape codes (no `chalk`) keep this zero-dependency: `\x1b[<code>m`
// switches the terminal to a color, `\x1b[0m` resets it. `pino` structured
// logging is deferred to Phase 10.
const isDebug = process.env.LOG_LEVEL === 'debug';

export const colors = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

function ts() {
  return new Date().toISOString();
}

export const logger = {
  info: (msg) => console.log(colors.cyan(`[${ts()}] ${msg}`)),
  warn: (msg) => console.warn(colors.yellow(`[${ts()}] ⚠ ${msg}`)),
  error: (msg) => console.error(colors.red(`[${ts()}] ✗ ${msg}`)),
  debug: (msg) => {
    if (isDebug) console.error(colors.gray(`[${ts()}] [debug] ${msg}`));
  },
};
