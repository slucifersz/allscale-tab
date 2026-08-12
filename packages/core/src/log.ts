/**
 * Structured JSON logging: one `{ts, module, event, data}` object per line.
 *
 * Logs go to stdout by default, as specified. Processes that speak MCP over
 * stdio must not write anything but protocol frames to stdout, so they set
 * TAB_LOG_STREAM=stderr and the same records go to stderr instead.
 */

export interface Logger {
  log(event: string, data?: Record<string, unknown>): void;
  child(suffix: string): Logger;
}

function write(line: string): void {
  const stream = process.env.TAB_LOG_STREAM === 'stderr' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export function createLogger(moduleName: string): Logger {
  return {
    log(event, data) {
      write(
        JSON.stringify({
          ts: new Date().toISOString(),
          module: moduleName,
          event,
          data: data ?? {},
        }),
      );
    },
    child(suffix) {
      return createLogger(`${moduleName}.${suffix}`);
    },
  };
}
