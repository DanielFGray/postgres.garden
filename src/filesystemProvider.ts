import * as monaco from "monaco-editor";
import {
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
} from "@codingame/monaco-vscode-files-service-override";
import * as S from "effect/Schema";

export const workspaceFile = monaco.Uri.file("/workspace.code-workspace");

export const fileSystemProvider = new RegisteredFileSystemProvider(false);

// Note: test.sql was removed - playgrounds should start empty
// Files are loaded from server via workspaceSwitcher.ts

// Use a workspace file to be able to add another folder later (for the "Attach filesystem" button)
fileSystemProvider.registerFile(
  new RegisteredMemoryFile(
    workspaceFile,
    S.encodeSync(S.fromJsonString(S.Struct({ folders: S.Array(S.Struct({ path: S.String })) })))({
      folders: [
        {
          path: "/workspace",
        },
      ],
    }),
  ),
);
