# Plugin System Design for postgres.garden

**Status:** Planning  
**Date:** 2025-11-23  
**Goal:** Allow optional experimental plugins (like Postgraphile) for power users while keeping the pastebin experience lightweight for 99% of users

## Executive Summary

Instead of building a custom plugin system, **leverage the existing VSCode extension architecture** with open-vsx.org marketplace. This gives us:

- ✅ Extension management UI (built-in to VSCode workbench)
- ✅ User control (install/uninstall from Extensions panel)
- ✅ Version management & updates (handled by open-vsx.org)
- ✅ Zero persistence overhead (VSCode stores enabled extensions in IndexedDB)
- ✅ Discovery (users search for "postgres-garden-postgraphile")
- ✅ No new backend code needed

## Architecture

### Core Pattern: Extension API Export

Based on **VSCode Extension API standards**, extensions can expose APIs to other extensions through the `activate()` return value.

**Pattern source:** `vscode-extension-samples/jupyter-server-provider-sample/src/extension.ts:16-24`

```typescript
// Extension A exports an API
export function activate(context: vscode.ExtensionContext) {
  return {
    // Public API for other extensions
    someMethod() { ... }
  };
}

// Extension B consumes the API  
const extA = vscode.extensions.getExtension<ApiType>('publisher.extensionA');
await extA.activate();
const api = extA.exports;
api.someMethod();
```

## Implementation Plan

### Phase 1: Convert PGlite to Exportable API

**File:** `src/features/pglite.ts`

Convert the existing PGlite feature into an extension that exports a public API:

```typescript
import { registerExtension, ExtensionHostKind } from "@codingame/monaco-vscode-api/extensions";
import { PGliteWorker } from "@electric-sql/pglite/worker";

// Define the public API interface
export interface PostgresGardenAPI {
  getPGlite(): Promise<PGliteWorker>;
  resetDatabase(): Promise<void>;
}

// Existing PGliteService class (no changes needed)
export class PGliteService {
  // ... existing implementation ...
}

// Register as extension and export API
const { getApi } = registerExtension(
  {
    name: "postgres-garden-core",
    publisher: "postgres-garden",
    version: "1.0.0",
    engines: { vscode: "*" },
  },
  ExtensionHostKind.LocalProcess
);

void getApi().then(async (vscode) => {
  const service = new PGliteService();
  await service.initialize();
  
  // Return the public API (what other extensions access via .exports)
  return {
    getPGlite: () => service.getInstance(),
    resetDatabase: () => service.reset()
  } satisfies PostgresGardenAPI;
});
```

**Key Changes:**
- Define `PostgresGardenAPI` interface (the contract)
- Wrap PGliteService in `registerExtension()`
- Return API object from `getApi().then()`

**No Breaking Changes:**
- Existing code still works
- `PGliteService` class unchanged
- Can keep `window.db` for debugging (optional)

### Phase 2: Create Example Plugin - Postgraphile

**Structure:**
```
postgres-garden-postgraphile/
├── src/
│   └── extension.ts
├── package.json
├── tsconfig.json
└── README.md
```

**File:** `postgres-garden-postgraphile/src/extension.ts`

```typescript
import * as vscode from 'vscode';
import { postgraphile } from 'postgraphile';

// Copy or import the API interface
interface PostgresGardenAPI {
  getPGlite(): Promise<any>;
  resetDatabase(): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext) {
  // Get the core extension
  const coreExt = vscode.extensions.getExtension<PostgresGardenAPI>(
    'postgres-garden.postgres-garden-core'
  );
  
  if (!coreExt) {
    vscode.window.showErrorMessage(
      'Postgraphile plugin requires postgres.garden core'
    );
    return;
  }
  
  // Ensure it's activated and get API
  if (!coreExt.isActive) {
    await coreExt.activate();
  }
  
  const api = coreExt.exports;
  if (!api) {
    vscode.window.showErrorMessage('postgres.garden API not available');
    return;
  }
  
  // Get PGlite instance
  const db = await api.getPGlite();
  
  // Register command to start GraphiQL
  const startCmd = vscode.commands.registerCommand(
    'postgres-garden-postgraphile.start',
    async () => {
      const panel = vscode.window.createWebviewPanel(
        'postgraphile',
        'GraphiQL',
        vscode.ViewColumn.One,
        { enableScripts: true }
      );
      
      // Run postgraphile against PGlite
      const middleware = postgraphile(db, 'public', {
        graphiql: true,
        enhanceGraphiql: true,
      });
      
      panel.webview.html = getGraphiQLHtml(middleware);
    }
  );
  
  context.subscriptions.push(startCmd);
}

function getGraphiQLHtml(middleware: any): string {
  // Return GraphiQL HTML with embedded endpoint
  return `<!DOCTYPE html>
    <html>
      <head>
        <title>GraphiQL</title>
        <!-- GraphiQL CSS/JS -->
      </head>
      <body>
        <div id="graphiql">Loading...</div>
      </body>
    </html>`;
}
```

**File:** `postgres-garden-postgraphile/package.json`

```json
{
  "name": "postgres-garden-postgraphile",
  "displayName": "Postgres Garden - Postgraphile",
  "description": "GraphQL API layer for postgres.garden via Postgraphile",
  "version": "0.1.0",
  "publisher": "postgres-garden",
  "engines": {
    "vscode": "^1.77.0"
  },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "extensionDependencies": [
    "postgres-garden.postgres-garden-core"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "postgres-garden-postgraphile.start",
        "title": "Start GraphiQL",
        "category": "Postgraphile"
      }
    ]
  },
  "dependencies": {
    "postgraphile": "^5.0.0"
  },
  "devDependencies": {
    "@types/vscode": "^1.77.0",
    "typescript": "^5.0.0"
  }
}
```

### Phase 3: Publishing & Distribution

#### Option A: Publish to open-vsx.org (Recommended)

```bash
# Package the extension
npm install -g @vscode/vsce
vsce package

# Publish to open-vsx.org
npx ovsx publish postgres-garden-postgraphile-0.1.0.vsix -p YOUR_TOKEN
```

**Benefits:**
- Users can search and install from Extensions panel
- Automatic version management
- Community can publish their own plugins

#### Option B: GitHub Releases (Simpler for experiments)

```bash
# Package the extension
vsce package

# Upload .vsix to GitHub Release
# Users install via "Install from VSIX..."
```

**Benefits:**
- No marketplace account needed
- Quick iteration
- Easy for experimental builds

#### Option C: Local Development

For development/testing, use the existing `registerRemoteExtension()` pattern:

```typescript
// Load from local filesystem during dev
if (window.rootDirectory != null) {
  void registerRemoteExtension(
    `${window.rootDirectory}/postgres-garden-postgraphile/`
  );
}
```

### Phase 4: Shared Types (Optional Enhancement)

For better type safety across multiple plugins:

**Create:** `@postgres-garden/types` npm package

```typescript
// packages/types/src/index.ts
export interface PostgresGardenAPI {
  getPGlite(): Promise<PGliteWorker>;
  resetDatabase(): Promise<void>;
}

export interface PGliteWorker {
  query(sql: string): Promise<QueryResult>;
  // ... other methods
}
```

**Publish to npm:**
```bash
npm publish @postgres-garden/types
```

**Use in both core and plugins:**
```typescript
import type { PostgresGardenAPI } from '@postgres-garden/types';
```

**Benefits:**
- Single source of truth for API types
- Version compatibility checking
- Better IDE support

## Key Design Decisions

### Why VSCode Extensions Instead of Custom Plugin System?

**Rejected Approach:** Custom plugin registry with database tables, API endpoints, and UI

**Chosen Approach:** Standard VSCode extensions via open-vsx.org

**Rationale:**
1. **Already built** - VSCode workbench has full extension support working
2. **Zero backend overhead** - No new database tables or API endpoints
3. **User familiar** - Extensions panel is standard VSCode UX
4. **Versioning free** - Marketplace handles updates automatically
5. **Community extensible** - Others can publish postgres-garden plugins
6. **Type-safe** - TypeScript interfaces define contracts

### Why Export API Instead of `window.db`?

**Rejected Approach:** Global `window.db` variable

**Chosen Approach:** Extension API export pattern

**Rationale:**
1. **Type-safe** - Interface contract enforced by TypeScript
2. **Explicit dependencies** - Extension declares it needs core
3. **Standard VSCode pattern** - Same as Jupyter, GitHub Copilot, etc.
4. **Versioned** - API interface can evolve with semver
5. **No global state** - Cleaner architecture

**Source:** `vscode-extension-samples/jupyter-server-provider-sample/src/extension.ts`

## References & Inspiration

### Primary Sources

1. **VSCode Extension API Pattern**
   - File: `vscode-extension-samples/jupyter-server-provider-sample/src/extension.ts:16-24`
   - Shows how Jupyter extension exports API for server providers
   - Pattern: `extensions.getExtension().exports`

2. **VSCode Extension Samples Repository**
   - Directory: `/vscode-extension-samples/`
   - Multiple examples of extension-to-extension communication
   - Standard patterns for activation, commands, webviews

3. **Internal Extension Pattern**
   - Files: `src/features/ai.ts`, `src/features/auth.ts`
   - Shows how to use `registerExtension()` for internal features
   - Pattern already working in postgres.garden

### VSCode Official Documentation

- [Extension API - Exports](https://code.visualstudio.com/api/references/vscode-api#Extension.exports)
- [Extension Capabilities](https://code.visualstudio.com/api/extension-capabilities/overview)
- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

### Open-VSX Registry

- Website: https://open-vsx.org/
- Already configured in `src/setup.common.ts:212-216`
- Users can already install extensions from gallery

## User Experience

### For 99% of Users (Pastebin)

**No change:** Extension system is opt-in only. Zero overhead.

### For Power Users (Experimental Features)

**Discovery:**
1. Open Extensions panel (`Ctrl+Shift+X`)
2. Search "postgres-garden"
3. See available plugins (Postgraphile, Apache Arrow, etc.)

**Installation:**
1. Click "Install" on desired plugin
2. Extension auto-activates
3. New commands appear in Command Palette

**Usage:**
1. `Cmd+Shift+P` → "Postgraphile: Start GraphiQL"
2. Opens GraphiQL panel
3. Query PGlite database via GraphQL

**Uninstall:**
1. Extensions panel → Right-click → Uninstall
2. Zero traces left

## Future Plugin Ideas

With this system in place, easy to add:

- **postgres-garden-postgraphile** - GraphQL API via Postgraphile
- **postgres-garden-hasura** - GraphQL API via Hasura
- **postgres-garden-apache-arrow** - Export query results to Arrow format
- **postgres-garden-csv-import** - CSV file import tools
- **postgres-garden-schema-visualizer** - ER diagram generator
- **postgres-garden-migrations** - Migration tooling
- **postgres-garden-backups** - Backup/restore utilities

Community could also publish their own!

## Migration Path

### Phase 1: Internal Refactor (Non-Breaking)
- [ ] Add `PostgresGardenAPI` interface to `src/features/pglite.ts`
- [ ] Wrap PGliteService in `registerExtension()` 
- [ ] Return API object from activation
- [ ] Test existing features still work
- [ ] Keep `window.db` for debugging (optional)

### Phase 2: First Plugin (Experimental)
- [ ] Create `postgres-garden-postgraphile` directory
- [ ] Implement extension using API pattern
- [ ] Test locally with `registerRemoteExtension()`
- [ ] Package as .vsix
- [ ] Upload to GitHub Releases for testing

### Phase 3: Publish to Marketplace (Optional)
- [ ] Create open-vsx.org publisher account
- [ ] Publish core as `postgres-garden.postgres-garden-core` (if needed)
- [ ] Publish postgraphile plugin
- [ ] Update docs with plugin installation instructions

### Phase 4: Types Package (Optional)
- [ ] Create `@postgres-garden/types` npm package
- [ ] Publish to npm
- [ ] Update core and plugins to use shared types

## Open Questions

1. **Should core be published as extension?**
   - Current: Core features use `registerExtension()` but aren't published
   - Option A: Keep as-is, plugins just depend on extension ID
   - Option B: Publish core to open-vsx.org for version tracking

2. **Local development workflow?**
   - How do plugin developers test locally?
   - Use `registerRemoteExtension()` with file:// URL?
   - Document in CONTRIBUTING.md?

3. **API versioning strategy?**
   - Semver for `PostgresGardenAPI` interface?
   - Breaking changes handled how?
   - Multiple API versions supported?

4. **Plugin discovery?**
   - Tag extensions with "postgres-garden-plugin"?
   - Curated list on website?
   - In-app recommendations?

## Success Metrics

- ✅ Zero overhead for 99% of users (no code changes for pastebin)
- ✅ No new backend code (database, API routes, etc.)
- ✅ Type-safe API contract between core and plugins
- ✅ Standard VSCode UX (Extensions panel)
- ✅ Community can publish plugins
- ✅ Easy to experiment with new plugins

## Next Steps

1. Review this plan with team
2. Decide on migration timeline
3. Start with Phase 1 (internal refactor)
4. Build postgraphile plugin as proof-of-concept
5. Test end-to-end workflow
6. Document plugin development guide

---

**Last Updated:** 2025-11-23  
**Author:** AI Assistant (based on VSCode extension samples)  
**Status:** Awaiting review
