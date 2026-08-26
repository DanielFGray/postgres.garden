export function randomNumber(max: number): number;
export function randomNumber(min: number, max: number): number;
export function randomNumber(min: number, max?: number): number {
  if (!max) [min, max] = [0, min];
  if (min > max) [min, max] = [max, min];
  const bytes = new Uint32Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return Math.floor(min + (bytes[0]! / 0xffffffff) * (max - min));
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
