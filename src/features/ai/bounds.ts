/**
 * Execution budgets for one agent run. A tool that hits one tells the model
 * in its result text, so the next turn can narrow the request.
 */

export const MAX_AGENT_ITERATIONS = 12;
export const MAX_TOOL_OUTPUT_CHARS = 32_000;
export const MAX_FILE_READ_CHARS = 32_000;
export const MAX_SQL_ROWS = 200;
export const MAX_LIST_ENTRIES = 500;

export const truncateText = (text: string, maxChars: number) => ({
  text: text.slice(0, maxChars),
  truncated: text.length > maxChars,
});

export const truncateRows = <A>(rows: ReadonlyArray<A>, maxRows: number) => ({
  rows: rows.slice(0, maxRows),
  truncated: rows.length > maxRows,
});
