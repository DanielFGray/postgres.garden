import * as vscode from "vscode";

export class MarkdownSerializer implements vscode.NotebookSerializer {
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  deserializeNotebook(data: Uint8Array): vscode.NotebookData {
    const content = this.decoder.decode(data);

    const cellRawData = parseMarkdown(content);
    const cells = cellRawData.map(rawToNotebookCellData);

    return { cells };
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array | Thenable<Uint8Array> {
    const stringOutput = writeCellsToMarkdown(data.cells);
    return this.encoder.encode(stringOutput);
  }
}

export function rawToNotebookCellData(data: RawNotebookCell): vscode.NotebookCellData {
  return {
    kind: data.kind,
    languageId: data.language,
    metadata: {
      leadingWhitespace: data.leadingWhitespace,
      trailingWhitespace: data.trailingWhitespace,
      indentation: data.indentation,
    },
    outputs: [],
    value: data.content,
  } satisfies vscode.NotebookCellData;
}

export interface RawNotebookCell {
  indentation?: string;
  leadingWhitespace: string;
  trailingWhitespace: string;
  language: string;
  content: string;
  kind: vscode.NotebookCellKind;
}

/** Typed shape of the metadata we store on markdown notebook cells */
interface MarkdownCellMetadata {
  leadingWhitespace?: string;
  trailingWhitespace?: string;
  indentation?: string;
}

interface ICodeBlockStart {
  langId: string;
  indentation: string;
}

/**
 * Note - the indented code block parsing is basic. It should only be applied inside lists, indentation should be consistent across lines and
 * between the start and end blocks, etc. This is good enough for typical use cases.
 */
function parseCodeBlockStart(line: string): ICodeBlockStart | null {
  const match = line.match(/( {4}|\t)?```(\S*)/);
  if (!match) return null;
  return {
    indentation: match[1] ?? "",
    langId: match[2] ?? "",
  };
}

function isCodeBlockStart(line: string): boolean {
  return !!parseCodeBlockStart(line);
}

function isCodeBlockEndLine(line: string): boolean {
  return !!line.match(/^\s*```/);
}

export function parseMarkdown(content: string): RawNotebookCell[] {
  const lines = content.split(/\r?\n/g);
  const cells: RawNotebookCell[] = [];
  let i = 0;

  // Each parse function starts with line i, leaves i on the line after the last line parsed
  for (; i < lines.length; ) {
    const leadingWhitespace = i === 0 ? parseWhitespaceLines(true) : "";
    if (i >= lines.length) {
      break;
    }
    const codeBlockMatch = parseCodeBlockStart(lines[i]!);
    if (codeBlockMatch) {
      parseCodeBlock(leadingWhitespace, codeBlockMatch);
    } else {
      parseMarkdownParagraph(leadingWhitespace);
    }
  }

  function parseWhitespaceLines(isFirst: boolean): string {
    const start = i;
    const nextNonWhitespaceLineOffset = lines.slice(start).findIndex((l) => l !== "");
    let end: number; // will be next line or overflow
    let isLast = false;
    if (nextNonWhitespaceLineOffset < 0) {
      end = lines.length;
      isLast = true;
    } else {
      end = start + nextNonWhitespaceLineOffset;
    }

    i = end;
    const numWhitespaceLines = end - start + (isFirst || isLast ? 0 : 1);
    return "\n".repeat(numWhitespaceLines);
  }

  function parseCodeBlock(leadingWhitespace: string, codeBlockStart: ICodeBlockStart): void {
    const startSourceIdx = ++i;
    while (true) {
      const currLine = lines[i];
      if (i >= lines.length) {
        break;
      } else if (currLine && isCodeBlockEndLine(currLine)) {
        i++; // consume block end marker
        break;
      }

      i++;
    }

    const content = lines
      .slice(startSourceIdx, i - 1)
      .map((line) => line.replace(new RegExp("^" + codeBlockStart.indentation), ""))
      .join("\n");
    const trailingWhitespace = parseWhitespaceLines(false);
    cells.push({
      language: codeBlockStart.langId,
      content,
      kind: vscode.NotebookCellKind.Code,
      leadingWhitespace: leadingWhitespace,
      trailingWhitespace: trailingWhitespace,
      indentation: codeBlockStart.indentation,
    });
  }

  function parseMarkdownParagraph(leadingWhitespace: string): void {
    const startSourceIdx = i;
    while (true) {
      if (i >= lines.length) {
        break;
      }

      const currLine = lines[i];
      if (!currLine || isCodeBlockStart(currLine)) {
        break;
      }

      i++;
    }

    const content = lines.slice(startSourceIdx, i).join("\n");
    const trailingWhitespace = parseWhitespaceLines(false);
    cells.push({
      language: "markdown",
      content,
      kind: vscode.NotebookCellKind.Markup,
      leadingWhitespace: leadingWhitespace,
      trailingWhitespace: trailingWhitespace,
    });
  }

  return cells;
}

export function writeCellsToMarkdown(cells: ReadonlyArray<vscode.NotebookCellData>): string {
  let result = "";
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const meta = cell.metadata as MarkdownCellMetadata | undefined;
    if (i === 0) {
      result += meta?.leadingWhitespace ?? "";
    }

    if (cell.kind === vscode.NotebookCellKind.Code) {
      const indentation = meta?.indentation || "";
      const codePrefix = indentation + "```" + cell.languageId + "\n";
      const contents = cell.value
        .split(/\r?\n/g)
        .map((line) => indentation + line)
        .join("\n");
      const codeSuffix = "\n" + indentation + "```";

      result += codePrefix + contents + codeSuffix;
    } else {
      result += cell.value;
    }

    result += getBetweenCellsWhitespace(cells, i);
  }
  return result;
}

function getBetweenCellsWhitespace(
  cells: ReadonlyArray<vscode.NotebookCellData>,
  idx: number,
): string {
  const thisCell = cells[idx]!;
  const thisMeta = thisCell.metadata as MarkdownCellMetadata | undefined;
  const nextCell = cells[idx + 1];

  if (!nextCell) {
    return thisMeta?.trailingWhitespace ?? "\n";
  }

  const nextMeta = nextCell.metadata as MarkdownCellMetadata | undefined;
  const trailing = thisMeta?.trailingWhitespace;
  const leading = nextMeta?.leadingWhitespace;

  if (typeof trailing === "string" && typeof leading === "string") {
    return trailing + leading;
  }

  // One of the cells is new
  const combined = (trailing ?? "") + (leading ?? "");
  if (!combined || combined === "\n") {
    return "\n\n";
  }

  return combined;
}
