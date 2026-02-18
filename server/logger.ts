import { Elysia } from "elysia";

export interface LoggerOptions {
  /** Skip logging for certain paths (e.g., health checks) */
  skip?: string[];
  /** Log request body (be careful with sensitive data) */
  logBody?: boolean;
  /** Use colorized output */
  colorize?: boolean;
}

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function statusColor(status: number): string {
  if (status >= 500) return colors.red;
  if (status >= 400) return colors.yellow;
  if (status >= 300) return colors.cyan;
  return colors.green;
}

function formatDuration(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  if (ms < 100) return `${ms.toFixed(0)}ms`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Elysia middleware for logging HTTP requests with timing information.
 *
 * @example
 * ```ts
 * import { logger } from "./logger";
 *
 * const app = new Elysia()
 *   .use(logger({ skip: ["/health"] }))
 *   .get("/hello", () => "world");
 * ```
 */
const requestMeta = new WeakMap<Request, { startTime: number; shouldSkip: boolean }>();

export const logger = (options: LoggerOptions = {}) => {
  const { skip = [], logBody = false, colorize = true } = options;

  return new Elysia({ name: "logger" }).onRequest(({ request }) => {
    const startTime = performance.now();

    const url = new URL(request.url);
    const path = url.pathname;

    // Check if we should skip this path
    const shouldSkip = skip.some(
      (skipPath) => path === skipPath || path.startsWith(skipPath),
    );

    requestMeta.set(request, { startTime, shouldSkip });

    if (shouldSkip) return;

    const method = request.method;

    // Log incoming request
    const timestamp = new Date().toISOString();
    const c = colorize ? colors : { reset: "", dim: "", cyan: "", magenta: "" };

    console.log(
      `${c.dim}${timestamp}${c.reset} ${c.magenta}${method}${c.reset} ${c.cyan}${url.pathname}${c.reset}${url.search || ""}${logBody && request.body ? ` ${c.dim}body=${JSON.stringify(request.body)}${c.reset}` : ""}`,
    );
  }).onAfterResponse(({ request, set }) => {
    const meta = requestMeta.get(request);
    if (!meta || meta.shouldSkip) return;
    const { startTime } = meta;

    const duration = performance.now() - startTime;
    const status = set.status ?? 200;
    const statusNum = typeof status === "number" ? status : 200;
    const method = request.method;
    const url = new URL(request.url);
    const c = colorize ? colors : { reset: "", dim: "", green: "", yellow: "", red: "" };

    console.log(
      `${c.dim}${new Date().toISOString()}${c.reset} ${method} ${url.pathname} ${statusColor(statusNum)}${statusNum}${c.reset} ${c.dim}${formatDuration(duration)}${c.reset}`,
    );
  });
};

/**
 * Simple request logger that logs method, path, status, and duration.
 * Logs both request start and response completion.
 *
 * Output format:
 *   <timestamp> <METHOD> <path>
 *   <timestamp> <METHOD> <path> <status> <duration>
 *
 * Example:
 *   2025-01-15T10:30:00.000Z GET /api/playgrounds
 *   2025-01-15T10:30:00.050Z GET /api/playgrounds 200 50ms
 */
export const requestLogger = logger;
