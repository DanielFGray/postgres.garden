/**
 * The four tools the agent can call. Each definition owns its Effect `Tool`
 * (name, model description, parameter schema); the VS Code manifest entry,
 * the `LanguageModelChatTool` sent with a request and the provider toolkit
 * are all derived from it.
 */

import { Tool, Toolkit } from "effect/ai";
import { Effect, Match, Option } from "effect";
import * as S from "effect/Schema";
import type * as vscode from "vscode";
import {
  MAX_FILE_READ_CHARS,
  MAX_LIST_ENTRIES,
  MAX_SQL_ROWS,
  MAX_TOOL_OUTPUT_CHARS,
  truncateRows,
  truncateText,
} from "./bounds";
import type { AgentRun } from "./runs";
import { resolveWorkspacePath, workspaceRelativePath } from "./sandbox";

export type AgentToolName = (typeof agentTools)[number]["tool"]["name"];

const ListFilesParams = S.Struct({
  path: S.optionalKey(S.String).annotate({
    description: "Directory relative to the workspace root; the root when absent",
  }),
});

const ReadFileParams = S.Struct({
  path: S.String.annotate({ description: "File path relative to the workspace root" }),
});

const ApplyEditParams = S.Struct({
  path: S.String.annotate({ description: "File path relative to the workspace root" }),
  content: S.String.annotate({ description: "The complete new contents of the file" }),
});

const RunSqlParams = S.Struct({
  sql: S.String.annotate({ description: "One or more SQL statements" }),
});

/**
 * Tools one request may call: every agent tool, less those `ChatRequest.tools`
 * marks off. VS Code marks off the tools the selected chat agent does not
 * list (a request may mark mutating tools off) and the
 * tools the user turned off in the tool picker.
 */
export const toolsForRequest = (
  enablement: ReadonlyMap<{ readonly name: string }, boolean>,
): ReadonlySet<AgentToolName> => {
  const disabled = new Set(
    [...enablement].filter(([, enabled]) => !enabled).map(([info]) => info.name),
  );
  return new Set(agentToolNames().filter((name) => !disabled.has(name)));
};

/** Narrows a model-supplied tool name to one of `tools`, which a run may call. */
export const authorizeTool = (tools: ReadonlySet<AgentToolName>, name: string) =>
  Effect.fromOption(
    Option.fromNullishOr([...tools].find((tool) => tool === name)),
    () => new ToolNotAllowedError({ tool: name }),
  );

/** A tool call as VS Code delivers it: the tool's name and its decoded input. */
export const AgentToolCall = S.Union([
  S.Struct({ name: S.Literal("listFiles"), input: ListFilesParams }),
  S.Struct({ name: S.Literal("readFile"), input: ReadFileParams }),
  S.Struct({ name: S.Literal("applyEdit"), input: ApplyEditParams }),
  S.Struct({ name: S.Literal("runSql"), input: RunSqlParams }),
]);
export type AgentToolCall = typeof AgentToolCall.Type;

/** Decodes the input VS Code passed to tool `name`'s `invoke`. */
export const decodeToolCall = (
  name: AgentToolName,
  options: vscode.LanguageModelToolInvocationOptions<unknown>,
) =>
  S.decodeUnknownEffect(AgentToolCall)({ name, input: options.input }).pipe(
    Effect.mapError((issue) => new ToolInputError({ tool: name, issue: issue.message })),
  );

/** Runs one tool call for `run`. */
export const invokeAgentTool = Effect.fnUntraced(function* (
  vscodeApi: typeof vscode,
  call: AgentToolCall,
  run: AgentRun,
) {
  if (run.token.isCancellationRequested) return yield* new RunCancelledError();
  yield* authorizeTool(run.tools, call.name);
  return yield* Match.value(call).pipe(
    Match.discriminators("name")({
      listFiles: (c) => run.workspace.guard(listFiles(vscodeApi, run, c.input)),
      readFile: (c) => run.workspace.guard(readFile(vscodeApi, run, c.input)),
      // The existence check and the edit run under one guard, so a
      // playground load cannot start between them.
      applyEdit: (c) => run.workspace.guard(applyEdit(vscodeApi, run, c.input)),
      runSql: (c) => runSql(run, c.input),
    }),
    Match.exhaustive,
  );
});

/** The provider toolkit for the tools named in one model request. */
export const toolkitFor = (names: ReadonlySet<string>) =>
  Toolkit.make(...agentTools.map((def) => def.tool).filter((tool) => names.has(tool.name)));

export const languageModelChatTools = (names: ReadonlySet<AgentToolName>) =>
  agentTools
    .filter((def) => names.has(def.tool.name))
    .map((def): vscode.LanguageModelChatTool => ({
      name: def.tool.name,
      description: def.description,
      inputSchema: Tool.getJsonSchema(def.tool),
    }));

export const languageModelToolContributions = () =>
  agentTools.map((def) => ({
    name: def.tool.name,
    toolReferenceName: def.tool.name,
    displayName: def.displayName,
    userDescription: def.userDescription,
    modelDescription: def.description,
    canBeReferencedInPrompt: true,
    tags: [...def.tags],
    inputSchema: Tool.getJsonSchema(def.tool),
  }));

export class ToolInputError extends S.TaggedError<
  ToolInputError,
  { readonly brand: unique symbol }
>()("ToolInputError", {
  tool: S.String,
  issue: S.String,
}) {
  override get message() {
    return `Invalid ${this.tool} input: ${this.issue}`;
  }
}

export class ToolNotAllowedError extends S.TaggedError<
  ToolNotAllowedError,
  { readonly brand: unique symbol }
>()("ToolNotAllowedError", { tool: S.String }) {
  override get message() {
    return `Tool ${this.tool} is not available in this chat mode, or is turned off for this request.`;
  }
}

export class RunCancelledError extends S.TaggedError<
  RunCancelledError,
  { readonly brand: unique symbol }
>()("RunCancelledError", {}) {
  override get message() {
    return "The agent run was stopped; no further tool calls run.";
  }
}

export class WorkspaceFsError extends S.TaggedError<
  WorkspaceFsError,
  { readonly brand: unique symbol }
>()("WorkspaceFsError", {
  path: S.String,
  cause: S.String,
}) {
  override get message() {
    return `${this.path}: ${this.cause}`;
  }
}

export class EditRejectedError extends S.TaggedError<
  EditRejectedError,
  { readonly brand: unique symbol }
>()("EditRejectedError", {
  path: S.String,
}) {
  override get message() {
    return `The editor rejected the edit to ${this.path}.`;
  }
}

export class SqlError extends S.TaggedError<SqlError, { readonly brand: unique symbol }>()(
  "SqlError",
  { cause: S.String },
) {
  override get message() {
    return `SQL failed: ${this.cause}`;
  }
}

/**
 * One tool definition: the description goes both to the Effect `Tool` and
 * to the VS Code entries derived from this definition.
 */
const defineTool = <const Name extends string, Parameters extends S.Top>(spec: {
  readonly name: Name;
  readonly description: string;
  readonly parameters: Parameters;
  readonly displayName: string;
  readonly userDescription: string;
  readonly tags: ReadonlyArray<string>;
}) => ({
  ...spec,
  tool: Tool.make(spec.name, { description: spec.description, parameters: spec.parameters }),
});

const agentTools = [
  defineTool({
    name: "listFiles",
    description: `List files under a directory of the active workspace (at most ${MAX_LIST_ENTRIES} entries).`,
    parameters: ListFilesParams,
    displayName: "List workspace files",
    userDescription: "List files in the active postgres.garden workspace",
    tags: ["workspace"],
  }),
  defineTool({
    name: "readFile",
    description: `Read a UTF-8 text file from the active workspace (at most ${MAX_FILE_READ_CHARS} characters).`,
    parameters: ReadFileParams,
    displayName: "Read workspace file",
    userDescription: "Read a file from the active postgres.garden workspace",
    tags: ["workspace"],
  }),
  defineTool({
    name: "applyEdit",
    description:
      "Create a file or replace its whole contents in the active workspace. The user can undo the edit.",
    parameters: ApplyEditParams,
    displayName: "Edit workspace file",
    userDescription: "Create or replace a file in the active workspace (undoable)",
    tags: ["workspace"],
  }),
  defineTool({
    name: "runSql",
    description: `Execute SQL against the active PGlite database, including catalog queries that inspect its structure (at most ${MAX_SQL_ROWS} rows per statement are returned).`,
    parameters: RunSqlParams,
    displayName: "Run SQL",
    userDescription: "Execute SQL against the active PGlite database",
    tags: ["database"],
  }),
];

/** The names of all agent tools, each registered with `vscode.lm.registerTool`. */
export const agentToolNames = () => agentTools.map((def) => def.tool.name);

const listFiles = (vscodeApi: typeof vscode, run: AgentRun, params: typeof ListFilesParams.Type) =>
  resolveWorkspacePath(vscodeApi, run.workspaceRoot, params.path ?? "").pipe(
    Effect.flatMap((dir) => walk(vscodeApi, dir, MAX_LIST_ENTRIES + 1)),
    Effect.map((files) => {
      const listed = truncateRows(
        files.map((uri) => workspaceRelativePath(run.workspaceRoot, uri)),
        MAX_LIST_ENTRIES,
      );
      return withNotice(
        listed.rows.join("\n") || "(no files)",
        listed.truncated ? `more than ${MAX_LIST_ENTRIES} files; list a subdirectory` : undefined,
      );
    }),
  );

const readFile = (vscodeApi: typeof vscode, run: AgentRun, params: typeof ReadFileParams.Type) =>
  resolveWorkspacePath(vscodeApi, run.workspaceRoot, params.path).pipe(
    Effect.flatMap((uri) =>
      Effect.tryPromise({
        try: () => vscodeApi.workspace.fs.readFile(uri),
        catch: (cause) => new WorkspaceFsError({ path: params.path, cause: String(cause) }),
      }),
    ),
    Effect.map((bytes) => {
      const text = truncateText(new TextDecoder().decode(bytes), MAX_FILE_READ_CHARS);
      return withNotice(
        text.text,
        text.truncated ? `file truncated at ${MAX_FILE_READ_CHARS} characters` : undefined,
      );
    }),
  );

/**
 * Replaces the whole document through `workspace.applyEdit`, so open editors
 * see the change and the user can undo it. A missing file is created first.
 */
const applyEdit = Effect.fnUntraced(function* (
  vscodeApi: typeof vscode,
  run: AgentRun,
  params: typeof ApplyEditParams.Type,
) {
  const uri = yield* resolveWorkspacePath(vscodeApi, run.workspaceRoot, params.path);
  const fsError = (cause: unknown) =>
    new WorkspaceFsError({ path: params.path, cause: String(cause) });
  const exists = yield* Effect.tryPromise({
    try: () => vscodeApi.workspace.fs.stat(uri),
    catch: (cause) =>
      cause instanceof vscodeApi.FileSystemError && cause.code === "FileNotFound"
        ? new FileNotFoundError()
        : fsError(cause),
  }).pipe(
    Effect.as(true),
    Effect.catchTag("FileNotFoundError", () => Effect.succeed(false)),
  );
  const edit = new vscodeApi.WorkspaceEdit();
  if (exists) {
    const document = yield* Effect.tryPromise({
      try: () => vscodeApi.workspace.openTextDocument(uri),
      catch: fsError,
    });
    const end = document.positionAt(document.getText().length);
    edit.replace(uri, new vscodeApi.Range(new vscodeApi.Position(0, 0), end), params.content);
  } else {
    edit.createFile(uri);
    edit.insert(uri, new vscodeApi.Position(0, 0), params.content);
  }
  const applied = yield* Effect.tryPromise({
    try: () => vscodeApi.workspace.applyEdit(edit),
    catch: fsError,
  });
  if (!applied) return yield* new EditRejectedError({ path: params.path });
  return `${exists ? "Replaced" : "Created"} ${workspaceRelativePath(run.workspaceRoot, uri)} (${params.content.length} characters).`;
});

const runSql = (run: AgentRun, params: typeof RunSqlParams.Type) =>
  run.database.exec(params.sql).pipe(
    Effect.catchTag("PGliteError", (error) =>
      Effect.fail(new SqlError({ cause: error.cause ?? "unknown PGlite error" })),
    ),
    Effect.map((results) => {
      const statements = results.map((result) => {
        const rows = truncateRows(result.rows, MAX_SQL_ROWS);
        return {
          statement: result.statement,
          rowCount: result.rows.length,
          rows: rows.rows,
          truncated: rows.truncated,
        };
      });
      const text = truncateText(JSON.stringify(statements, null, 2), MAX_TOOL_OUTPUT_CHARS);
      return withNotice(
        text.text,
        statements.some((statement) => statement.truncated)
          ? `rows beyond ${MAX_SQL_ROWS} per statement omitted; rowCount is the full count`
          : text.truncated
            ? `output truncated at ${MAX_TOOL_OUTPUT_CHARS} characters`
            : undefined,
      );
    }),
  );

class FileNotFoundError extends S.TaggedError<
  FileNotFoundError,
  { readonly brand: unique symbol }
>()("FileNotFoundError", {}) {}

const withNotice = (text: string, notice: string | undefined) =>
  Option.fromNullishOr(notice).pipe(
    Option.match({ onNone: () => text, onSome: (reason) => `${text}\n\n[truncated: ${reason}]` }),
  );

/** Lists files under `dir` depth-first, stopping once `limit` files are found. */
const walk = (
  vscodeApi: typeof vscode,
  dir: vscode.Uri,
  limit: number,
): Effect.Effect<ReadonlyArray<vscode.Uri>, WorkspaceFsError> =>
  Effect.tryPromise({
    try: () => vscodeApi.workspace.fs.readDirectory(dir),
    catch: (cause) => new WorkspaceFsError({ path: dir.path, cause: String(cause) }),
  }).pipe(
    Effect.flatMap((entries) =>
      Effect.reduce(
        entries,
        (): ReadonlyArray<vscode.Uri> => [],
        (found, [name, type]): Effect.Effect<ReadonlyArray<vscode.Uri>, WorkspaceFsError> => {
          const uri = vscodeApi.Uri.joinPath(dir, name);
          if (found.length >= limit) return Effect.succeed(found);
          return type & vscodeApi.FileType.Directory
            ? walk(vscodeApi, uri, limit - found.length).pipe(
                Effect.map((nested) => [...found, ...nested]),
              )
            : Effect.succeed([...found, uri]);
        },
      ),
    ),
  );
