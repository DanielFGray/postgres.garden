export function randomNumber(max: number): number;
export function randomNumber(min: number, max: number): number;
export function randomNumber(min: number, max?: number): number {
  if (!max) [min, max] = [0, min];
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + Math.random() * (max - min));
}

/**
 * silly hack to enable syntax highlighting
 */
export const templateHack = (strings: TemplateStringsArray, ...exprs: unknown[]) =>
  strings.reduce(
    (acc, str, i) =>
      acc.concat(
        str,
        typeof exprs[i] === "string" ? exprs[i] : String(exprs[i] ?? ""), // oxlint-disable-line typescript/no-base-to-string
      ),
    "",
  );
