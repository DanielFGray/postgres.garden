### Overview

Create a custom notebook renderer using Preact that displays SQL query results with a toggle between HTML table and JSON tree views, with collapsible nodes.

---

### Phase 1: Dependencies & Setup

**Install required packages:**

```bash
bun add preact @preact/signals
bun add -d @types/vscode-notebook-renderer vscode-notebook-error-overlay
```

**Dependencies needed:**

- `preact` - Lightweight React alternative (~3KB)
- `@preact/signals` - Fine-grained reactivity system
- `@types/vscode-notebook-renderer` - TypeScript types
- `vscode-notebook-error-overlay` - Error handling wrapper

**Note:** JSX will be handled by Vite's built-in esbuild transform - no additional dependencies needed!

---

### Phase 2: File Structure

```
src/features/notebook/
├── controller.ts          (existing - minor update)
├── renderer/
│   ├── index.ts          (NEW - renderer entry point)
│   ├── SQLResultRenderer.tsx  (NEW - main Preact component)
│   ├── TableView.tsx     (NEW - HTML table view)
│   ├── JSONTreeView.tsx  (NEW - JSON tree with collapse)
│   ├── styles.css        (NEW - renderer styles)
│   └── types.ts          (NEW - shared types)
└── renderer-dist/         (build output)
    └── sql-renderer.js
```

---

### Phase 3: Renderer Component Design

**`src/features/notebook/renderer/types.ts`:**

```typescript
export interface SQLResult {
  fields: Array<{ name: string; dataTypeID?: number }>;
  rows: Array<Record<string, any>>;
}

export interface RendererProps {
  data: SQLResult;
  mime: string;
}

export type ViewMode = "table" | "json";
```

**`src/features/notebook/renderer/SQLResultRenderer.tsx`:**

```typescript
import { signal } from '@preact/signals';
import { TableView } from './TableView';
import { JSONTreeView } from './JSONTreeView';
import type { RendererProps, ViewMode } from './types';

export function SQLResultRenderer({ data, mime }: RendererProps) {
  const viewMode = signal<ViewMode>('table');

  return (
    <div class="sql-result-renderer">
      {/* Toggle toolbar */}
      <div class="toolbar">
        <button
          class={viewMode.value === 'table' ? 'active' : ''}
          onClick={() => viewMode.value = 'table'}
        >
          📊 Table
        </button>
        <button
          class={viewMode.value === 'json' ? 'active' : ''}
          onClick={() => viewMode.value = 'json'}
        >
          🌳 JSON
        </button>
      </div>

      {/* Content area */}
      <div class="content">
        {viewMode.value === 'table'
          ? <TableView data={data} />
          : <JSONTreeView data={data} />
        }
      </div>
    </div>
  );
}
```

**`src/features/notebook/renderer/JSONTreeView.tsx`:**

```typescript
import { signal } from '@preact/signals';

export function JSONTreeView({ data }: { data: any }) {
  return (
    <div class="json-tree">
      <TreeNode value={data} name="result" depth={0} />
    </div>
  );
}

function TreeNode({ value, name, depth }: any) {
  const collapsed = signal(depth > 2);

  if (value === null) {
    return <div class="null-value">{name}: null</div>;
  }

  if (typeof value !== 'object') {
    return <div class="primitive">{name}: {JSON.stringify(value)}</div>;
  }

  const isArray = Array.isArray(value);
  const keys = isArray ? value.map((_, i) => i) : Object.keys(value);

  return (
    <div class="tree-node" style={`margin-left: ${depth * 16}px`}>
      <div
        class="node-header"
        onClick={() => collapsed.value = !collapsed.value}
      >
        <span class="toggle">{collapsed.value ? '▶' : '▼'}</span>
        <span class="name">{name}</span>
        <span class="type">
          {isArray ? `Array[${keys.length}]` : `Object{${keys.length}}`}
        </span>
      </div>

      {!collapsed.value && (
        <div class="children">
          {keys.map(key =>
            <TreeNode
              key={key}
              name={key}
              value={value[key]}
              depth={depth + 1}
            />
          )}
        </div>
      )}
    </div>
  );
}
```

**`src/features/notebook/renderer/TableView.tsx`:**

```typescript
import type { SQLResult } from './types';

export function TableView({ data }: { data: SQLResult }) {
  return (
    <table class="sql-table">
      <thead>
        <tr>
          {data.fields.map(field =>
            <th key={field.name}>{field.name}</th>
          )}
        </tr>
      </thead>
      <tbody>
        {data.rows.length === 0 ? (
          <tr>
            <td colspan={data.fields.length} class="empty">
              No results
            </td>
          </tr>
        ) : (
          data.rows.map((row, i) =>
            <tr key={i}>
              {data.fields.map(field =>
                <td key={field.name}>
                  {row[field.name] === null
                    ? <i class="null">null</i>
                    : String(row[field.name])
                  }
                </td>
              )}
            </tr>
          )
        )}
      </tbody>
    </table>
  );
}
```

**`src/features/notebook/renderer/index.ts`:**

```typescript
import { render } from 'preact';
import type { ActivationFunction } from 'vscode-notebook-renderer';
import errorOverlay from 'vscode-notebook-error-overlay';
import { SQLResultRenderer } from './SQLResultRenderer';
import './styles.css';

export const activate: ActivationFunction = () => ({
  renderOutputItem(outputItem, element) {
    let shadow = element.shadowRoot;
    if (!shadow) {
      shadow = element.attachShadow({ mode: 'open' });
      const root = document.createElement('div');
      root.id = 'root';
      shadow.append(root);
    }

    const root = shadow.querySelector<HTMLElement>('#root')!;

    errorOverlay.wrap(root, () => {
      const data = outputItem.json();
      render(
        <SQLResultRenderer data={data} mime={outputItem.mime} />,
        root
      );
    });
  },

  disposeOutputItem(outputId) {
    // Cleanup handled by Preact
  }
});
```

---

### Phase 4: Vite Build Configuration

Create **`vite.renderer.config.ts`:**

```typescript
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  esbuild: {
    jsxFactory: "h",
    jsxFragment: "Fragment",
    jsxImportSource: "preact",
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/features/notebook/renderer/index.ts"),
      formats: ["es"],
      fileName: "sql-renderer",
    },
    outDir: "src/features/notebook/renderer-dist",
    rollupOptions: {
      external: ["vscode-notebook-renderer"],
    },
    minify: false, // Easier debugging during development
    sourcemap: true,
  },
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
});
```

**Add build script to `package.json`:**

```json
{
  "scripts": {
    "build:renderer": "vite build --config vite.renderer.config.ts",
    "build": "run-s build:renderer build:server build:client"
  }
}
```

---

### Phase 5: Register Renderer in Extension

**Update `src/features/postgres.ts` - add to `contributes`:**

```typescript
contributes: {
  // ... existing contributes
  notebookRenderer: [
    {
      id: "pg-playground-sql-renderer",
      entrypoint: "./renderer/index.js",
      displayName: "SQL Results Renderer",
      mimeTypes: ["application/vnd.pg-playground.sql-result+json"],
    },
  ];
}
```

**After `registerExtension`, add file URL registration:**

```typescript
const { getApi, registerFileUrl } = registerExtension(...);

// Register renderer bundle (both with and without .js)
registerFileUrl(
  'renderer/index',
  new URL('./notebook/renderer-dist/sql-renderer.js', import.meta.url).toString(),
  { mimeType: "text/javascript" }
);

registerFileUrl(
  'renderer/index.js',
  new URL('./notebook/renderer-dist/sql-renderer.js', import.meta.url).toString(),
  { mimeType: "text/javascript" }
);
```

---

### Phase 6: Update Notebook Controller

**`src/features/notebook/controller.ts` - Update output generation:**

```typescript
if (result.fields.length > 0) {
  return new vscode.NotebookCellOutput([
    // Custom renderer output
    vscode.NotebookCellOutputItem.json(
      { fields: result.fields, rows: result.rows },
      "application/vnd.pg-playground.sql-result+json",
    ),
    // Fallback HTML table
    vscode.NotebookCellOutputItem.text(renderRowsAsTable(result), "text/html"),
  ]);
}
```

---

### Phase 7: Styling

**`src/features/notebook/renderer/styles.css`:**

```css
.sql-result-renderer {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  padding: 8px;
}

.toolbar {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  padding-bottom: 8px;
}

.toolbar button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  padding: 4px 12px;
  cursor: pointer;
  border-radius: 3px;
}

.toolbar button.active {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

/* Table styles */
.sql-table {
  width: 100%;
  border-collapse: collapse;
}

.sql-table th,
.sql-table td {
  padding: 6px 12px;
  text-align: left;
  border: 1px solid var(--vscode-panel-border);
}

.sql-table th {
  background: var(--vscode-editor-background);
  font-weight: 600;
}

.sql-table .null {
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}

/* JSON tree styles */
.json-tree {
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size);
}

.tree-node {
  user-select: text;
}

.node-header {
  cursor: pointer;
  padding: 2px 4px;
  display: flex;
  gap: 6px;
  align-items: center;
}

.node-header:hover {
  background: var(--vscode-list-hoverBackground);
}

.toggle {
  width: 12px;
  display: inline-block;
}

.name {
  color: var(--vscode-symbolIcon-propertyForeground);
  font-weight: 500;
}

.type {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.primitive {
  padding: 2px 4px 2px 32px;
}

.null-value {
  padding: 2px 4px 2px 32px;
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}
```

---

### Phase 8: Testing Checklist

1. **Build renderer**: `bun run build:renderer`
2. **Start dev server**: `bun run dev`
3. **Create/open SQL notebook** (.sql file)
4. **Execute query** with results
5. **Verify custom renderer** appears
6. **Test toggle** between Table and JSON views
7. **Test JSON tree** collapse/expand functionality
8. **Check VSCode theme colors** work correctly
9. **Test null values** display correctly
10. **Verify HMR** works for renderer changes

---

### Benefits of This Approach

✅ **Custom UI controls** - Full control over toggle buttons and interactions  
✅ **Lightweight** - Preact is only ~3KB, signals add minimal overhead  
✅ **Fine-grained reactivity** - Signals update only what changed, no re-renders  
✅ **Interactive JSON** - Collapsible tree instead of static JSON  
✅ **Theme-aware** - Uses VSCode CSS variables  
✅ **Type-safe** - Full TypeScript support  
✅ **Shadow DOM** - Style isolation from main page  
✅ **Fallback support** - HTML table as fallback for other renderers  
✅ **HMR support** - Fast development iteration  
✅ **JSX syntax** - Familiar React-like syntax instead of h() calls  
✅ **No hooks complexity** - Signals are simpler and more performant than hooks

---

### Future Enhancements (Not in this phase)

- CSV export button
- Column sorting in table view
- Search/filter in large results
- Mermaid diagram detection
- Copy to clipboard buttons
- Row count indicator
- Virtualized scrolling for large datasets

Ready to implement when you're ready to proceed! 🚀
