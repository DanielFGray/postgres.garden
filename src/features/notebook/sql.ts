import * as vscode from "vscode";

// Cell block delimiter
const DELIMITER = "\n\n";

export class SQLSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(context: Uint8Array): vscode.NotebookData {
    const str = new TextDecoder().decode(context);
    const blocks = splitSqlBlocks(str);

    const cells = blocks.map((query) => {
      if (/^(---+|\/\*+\*\/)$/.test(query)) {
        return new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, "***", "markdown");
      }
      if (query.startsWith("/*") && query.endsWith("*/")) {
        return new vscode.NotebookCellData(
          vscode.NotebookCellKind.Markup,
          stripCommentChars(query),
          "markdown",
        );
      }

      return new vscode.NotebookCellData(vscode.NotebookCellKind.Code, query, "sql");
    });
    return new vscode.NotebookData(cells);
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    return new TextEncoder().encode(
      data.cells
        .map(({ value, kind }) => {
          if (kind === vscode.NotebookCellKind.Code) return value;
          if (value === "***") return "---";
          const lines = value.split("\n");
          if (lines[0]?.trim().length === 0) return "";
          const withCommentChars = lines.map((line) => (!line ? " *" : " * " + line)).join("\n");
          return `/*\n${withCommentChars}\n */`;
        })
        .join(DELIMITER),
    );
  }
}

function stripCommentChars(query: string) {
  const lines = query.split("\n");
  const inner =
    /^\/\*\*?$/.exec(lines[0] ?? "") && /^\s*\*\//.exec(lines.at(-1) ?? "")
      ? lines.slice(1, -1)
      : lines;
  return (
    inner.every((line) => /(^ \*$|^-- |^ * )/.exec(line))
      ? inner.map((line) => line.slice(3) ?? "")
      : inner
  ).join("\n");
}

function splitSqlBlocks(raw: string): string[] {
  return raw.split(/\n\n(?!\s+)/).reduce<string[]>((blocks, block) => {
    if (block.trim().length > 0) {
      blocks.push(block);
      return blocks;
    }
    if (blocks.length < 1) {
      return blocks;
    }
    blocks[blocks.length - 1] += "\n\n";
    return blocks;
  }, []);
}
