import * as monaco from "monaco-editor";
import {
  RegisteredFileSystemProvider,
  RegisteredMemoryFile,
} from "@codingame/monaco-vscode-files-service-override";
import { IStoredWorkspace } from "@codingame/monaco-vscode-configuration-service-override";

export const workspaceFile = monaco.Uri.file("/workspace.code-workspace");

export const fileSystemProvider = new RegisteredFileSystemProvider(false);

// Note: test.sql was removed - playgrounds should start empty
// Files are loaded from server via workspaceSwitcher.ts

// Use a workspace file to be able to add another folder later (for the "Attach filesystem" button)
fileSystemProvider.registerFile(
  new RegisteredMemoryFile(
    workspaceFile,
    JSON.stringify(
      <IStoredWorkspace>{
        folders: [
          {
            path: "/workspace",
          },
        ],
      },
      null,
      2,
    ),
  ),
);

// fileSystemProvider.registerFile(
//   new RegisteredMemoryFile(
//     monaco.Uri.file('/workspace/.vscode/extensions.json'),
//     JSON.stringify(
//       {
//         recommendations: ['vscodevim.vim']
//       },
//       null,
//       2
//     )
//   )
// )
