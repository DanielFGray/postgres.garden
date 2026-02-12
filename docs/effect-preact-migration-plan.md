# Effect-TS + Preact Signals Migration Plan

## Executive Summary

This project currently has architectural "sprawl" across multiple concerns:

- **Mixed error handling** (throw strings, try/catch, manual state)
- **No dependency injection** (manual service instantiation)
- **Side effects everywhere** (global state, localStorage, fetch scattered)
- **Unstructured concurrency** (Promise.all with no timeout/retry/cancellation)
- **Vanilla webviews** (manual DOM, innerHTML re-renders, lost state)

**Solution:** Adopt **Effect-TS** for core logic/services and **Preact + Signals** for webview UIs.

## Current Architecture Problems

### 1. Service Layer Sprawl

**Problem:** Each feature implements HTTP calls differently:

```typescript
// PlaygroundService.ts - throws strings
throw new Error(`Failed to list: ${response.statusText}`)

// auth.ts - manual try/catch
try {
  const response = await fetch(...)
} catch (e) {
  vscode.window.showErrorMessage('Auth failed')
}

// serverSync.ts - callback errors
if (!response.ok) {
  console.error('Sync failed')
  return
}
```

**Impact:**

- No consistency in error handling
- Can't retry/timeout operations
- Hard to test (mocked fetch)
- No type-safe errors

### 2. Dependency Management Chaos

**Problem:** Services instantiated manually everywhere:

```typescript
// PlaygroundService - new instance every time
const service = new PlaygroundService();

// auth.ts - reads from globals
const initialData = (window as any).__INITIAL_DATA__;

// introspection.ts - calls vscode commands directly
await vscode.commands.executeCommand(PGLITE_EXECUTE, query);
```

**Impact:**

- Tight coupling (can't swap implementations)
- Hard to test (can't mock dependencies)
- No lifecycle management
- Implicit dependencies (window, vscode globals)

### 3. Webview Re-render Problems

**Problem:** Vanilla JS webviews use innerHTML replacement:

```javascript
// view/main.js - nukes entire list on every update
listContainer.innerHTML = filteredPlaygrounds.map((p) => `...`).join("");

// Re-attaches ALL event listeners every time
listContainer.querySelectorAll(".action-open").forEach((btn) => {
  btn.addEventListener("click", handler);
});
```

**Impact:**

- Lost scroll position
- Lost focus state
- Performance (re-creating all DOM nodes)
- Event listener churn
- Can't animate changes

### 4. Unstructured Concurrency

**Problem:** No control over async operations:

```typescript
// Multiple features doing async independently
Promise.all([auth.checkSession(), playgrounds.list(), sync.getHistory()]);
// No timeout, no retry, no cancellation, no structured errors
```

**Impact:**

- Hangs if one operation stalls
- Can't cancel in-flight requests
- No timeout handling
- Error propagation unclear

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Effect Services Layer                     │
│  (HttpClient, Auth, Playground, Sync, Database, VSCode)     │
│    • Dependency injection via Layers                         │
│    • Typed errors (FetchError, NetworkError, AuthError)      │
│    • Retry/timeout/fallback built-in                         │
│    • Testable (mock layers)                                  │
└─────────────────────────────────────────────────────────────┘
                              ▼
          ┌───────────────────────────────────────┐
          │      Effect Programs                   │
          │   (Business logic composition)         │
          │   • Type-safe error handling           │
          │   • Structured concurrency             │
          │   • Resource safety                    │
          └───────────────────────────────────────┘
                              ▼
          ┌───────────────────────────────────────┐
          │      Preact Signals                    │
          │   (Reactive UI state)                  │
          │   • Global reactive values             │
          │   • Auto-dependency tracking           │
          │   • Fine-grained updates               │
          └───────────────────────────────────────┘
                              ▼
          ┌───────────────────────────────────────┐
          │      Preact Components                 │
          │   (UI rendering)                       │
          │   • JSX templates                      │
          │   • Type-safe props                    │
          │   • Efficient re-renders               │
          └───────────────────────────────────────┘
```

## Migration Strategy

### Phase 1: Server Layer (Highest ROI) ⭐️

**Goal:** Replace Elysia route handlers with Effect-based services

**Files to modify:**

- `server/app.ts` - Elysia route handlers
- `server/auth.ts` - Authentication logic
- `server/db.ts` - Database access
- `server/data.ts` - SSR data fetching

**New structure:**

```typescript
// server/services/HttpClient.ts
export class HttpClient extends Effect.Service<HttpClient>()("HttpClient", {
  effect: Effect.gen(function* () {
    const config = yield* Config;
    return {
      fetch: (url: string, init?: RequestInit) =>
        Effect.tryPromise({
          try: () => fetch(url, init),
          catch: (e) => new NetworkError({ cause: e }),
        }),
    };
  }),
}) {}

// server/services/Database.ts
export class Database extends Effect.Service<Database>()("Database", {
  effect: Effect.gen(function* () {
    const pool = yield* DatabasePool;
    return {
      query: <T>(sql: string, params: unknown[]) =>
        Effect.tryPromise({
          try: () => pool.query<T>(sql, params),
          catch: (e) => new DatabaseError({ cause: e }),
        }),
    };
  }),
}) {}

// server/services/PlaygroundService.ts
export class PlaygroundService extends Effect.Service<PlaygroundService>()(
  "PlaygroundService",
  {
    effect: Effect.gen(function* () {
      const db = yield* Database;
      const auth = yield* AuthService;

      return {
        list: Effect.gen(function* () {
          const user = yield* auth.getCurrentUser();
          if (!user) return yield* Effect.fail(new UnauthorizedError());

          return yield* db
            .query<Playground>("SELECT * FROM playgrounds WHERE user_id = $1", [
              user.id,
            ])
            .pipe(Effect.retry({ times: 3 }), Effect.timeout("5 seconds"));
        }),
      };
    }),
  },
) {}

// server/routes/playgrounds.ts
app.get("/api/playgrounds", async (ctx) => {
  const program = Effect.gen(function* () {
    const service = yield* PlaygroundService;
    return yield* service.list();
  });

  const result = await Effect.runPromise(
    program.pipe(Effect.provide(ServerLayer)),
  );

  return result;
});
```

**Benefits:**

- Unified error handling (typed errors: UnauthorizedError, DatabaseError)
- Retry/timeout built-in
- Dependency injection (swap Database implementation for tests)
- Type-safe from DB to HTTP response

**Estimated effort:** 3-4 days

---

### Phase 2: VSCode Extension Services (Medium ROI) ⭐️⭐️

**Goal:** Wrap VSCode APIs in Effect services for composability

**Files to modify:**

- `src/features/playground/services/PlaygroundService.ts`
- `src/features/playground/providers/PlaygroundViewProvider.ts`
- `src/features/playground/providers/PlaygroundPanelProvider.ts`
- `src/features/auth.ts`
- `src/features/serverSync.ts`

**New structure:**

```typescript
// src/services/VSCodeWorkspace.ts
export class VSCodeWorkspace extends Effect.Service<VSCodeWorkspace>()('VSCodeWorkspace', {
  effect: Effect.gen(function* () {
    return {
      openTextDocument: (uri: vscode.Uri) =>
        Effect.tryPromise({
          try: () => vscode.workspace.openTextDocument(uri),
          catch: (e) => new OpenDocumentError({ uri, cause: e })
        }),

      saveAll: Effect.tryPromise({
        try: () => vscode.workspace.saveAll(),
        catch: (e) => new SaveError({ cause: e })
      })
    }
  })
}) {}

// src/services/PlaygroundService.ts (extension-side)
export class PlaygroundService extends Effect.Service<PlaygroundService>()('PlaygroundService', {
  effect: Effect.gen(function* () {
    const httpClient = yield* HttpClient

    return {
      list: Effect.gen(function* () {
        const response = yield* httpClient.get('/api/playgrounds')

        if (!response.ok) {
          return yield* Effect.fail(
            new FetchError({ status: response.status, message: response.statusText })
          )
        }

        return yield* Effect.tryPromise(() => response.json())
      }).pipe(
        Effect.retry({ times: 3, schedule: Schedule.exponential('100 millis') }),
        Effect.timeout('10 seconds'),
        Effect.catchTag('NetworkError', () => Effect.succeed([]))
      )
    }
  })
}) {}

// Usage in provider
private async loadPlaygrounds() {
  const program = Effect.gen(function* () {
    const service = yield* PlaygroundService
    return yield* service.list()
  })

  const playgrounds = await Effect.runPromise(
    program.pipe(Effect.provide(ExtensionLayer))
  )

  // Send to webview
  this._postMessage({ type: 'playgroundsList', data: playgrounds })
}
```

**Benefits:**

- VSCode API calls are retryable/timeout-able
- Composable operations (openAndSave, loadAndFormat)
- Testable (mock VSCodeWorkspace layer)
- Type-safe errors propagate up

**Estimated effort:** 4-5 days

---

### Phase 3: Webview Migration to Preact (High Value) ⭐️⭐️⭐️

**Goal:** Replace vanilla JS webviews with Preact + Signals + JSX

**Files to modify:**

- `src/features/playground/webview/view/main.js` → `main.tsx`
- `src/features/playground/webview/panel/main.js` → `main.tsx`
- Create shared component library
- Add Vite build config for webviews

**New structure:**

```typescript
// src/features/playground/webview/view/main.tsx
import { render } from 'preact'
import { signal, computed } from '@preact/signals'
import { Effect } from 'effect'

// State (global signals)
const playgrounds = signal<Playground[]>([])
const searchQuery = signal('')
const loading = signal(false)
const error = signal<string | null>(null)

// Computed (auto-updates)
const filteredPlaygrounds = computed(() =>
  playgrounds.value.filter(p =>
    p.name.toLowerCase().includes(searchQuery.value.toLowerCase())
  )
)

// Effect programs
const loadPlaygrounds = Effect.gen(function* () {
  loading.value = true
  error.value = null

  const service = yield* PlaygroundService
  const items = yield* service.list().pipe(
    Effect.catchAll((e) => {
      error.value = e.message
      return Effect.succeed([])
    })
  )

  playgrounds.value = items
  loading.value = false
})

// Components
function PlaygroundList() {
  return (
    <div class="playground-list">
      {loading.value && <Spinner />}
      {error.value && <ErrorMessage message={error.value} />}

      <SearchInput
        value={searchQuery.value}
        onChange={(e) => searchQuery.value = e.target.value}
      />

      {filteredPlaygrounds.value.map(p => (
        <PlaygroundItem key={p.id} playground={p} />
      ))}
    </div>
  )
}

function PlaygroundItem({ playground }: { playground: Playground }) {
  const handleOpen = () => {
    vscode.postMessage({ type: 'openPlayground', data: { id: playground.id } })
  }

  const handleDelete = async () => {
    if (confirm('Delete this playground?')) {
      await Effect.runPromise(deletePlayground(playground.id))
    }
  }

  return (
    <div class="playground-item">
      <h3>{playground.name}</h3>
      <p>{playground.description}</p>
      <div class="actions">
        <button onClick={handleOpen}>Open</button>
        <button onClick={handleDelete}>Delete</button>
      </div>
    </div>
  )
}

// Initialize
render(<PlaygroundList />, document.getElementById('root')!)
Effect.runPromise(loadPlaygrounds)
```

**Vite config additions:**

```typescript
// vite.config.ts
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [
    preact(),
    // ... existing plugins
  ],
  build: {
    rollupOptions: {
      input: {
        main: "./index.html",
        "playground-view": "./src/features/playground/webview/view/index.html",
        "playground-panel":
          "./src/features/playground/webview/panel/index.html",
      },
    },
  },
});
```

**Benefits:**

- JSX for declarative UI (vs manual DOM manipulation)
- Signals for efficient reactivity (only re-render what changed)
- Type-safe components
- Effect integration for complex workflows
- Better developer experience

**Estimated effort:** 5-6 days

---

### Phase 4: Shared Component Library (Polish) ⭐️

**Goal:** Create reusable VSCode-styled Preact components

**New files:**

```
src/components/
├── Button.tsx
├── Input.tsx
├── Spinner.tsx
├── ErrorMessage.tsx
├── List.tsx
└── index.ts
```

**Example:**

```typescript
// src/components/Button.tsx
import { JSX } from 'preact'

interface ButtonProps {
  children: JSX.Element | string
  onClick?: () => void
  icon?: string
  disabled?: boolean
  variant?: 'primary' | 'secondary' | 'danger'
}

export function Button({ children, onClick, icon, disabled, variant = 'primary' }: ButtonProps) {
  return (
    <button
      class={`vscode-button vscode-button--${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <i class={`codicon codicon-${icon}`} />}
      {children}
    </button>
  )
}
```

**Estimated effort:** 2-3 days

---

## Migration Timeline

### Week 1-2: Server Layer (Phase 1)

- Day 1-2: Set up Effect services structure
- Day 3-4: Migrate playground API endpoints
- Day 5-6: Migrate auth endpoints
- Day 7-8: Migrate SSR data fetching
- Day 9-10: Testing & refinement

### Week 3-4: Extension Services (Phase 2)

- Day 11-13: Wrap VSCode APIs in Effect services
- Day 14-16: Migrate PlaygroundService (extension-side)
- Day 17-18: Migrate auth provider
- Day 19-20: Migrate serverSync feature
- Day 21-22: Testing & refinement

### Week 5-6: Webviews (Phase 3)

- Day 23-24: Set up Preact build config
- Day 25-27: Migrate playground view webview
- Day 28-30: Migrate playground panel webview
- Day 31-33: Effect integration in webviews
- Day 34-36: Testing & refinement

### Week 7: Polish (Phase 4)

- Day 37-39: Build component library
- Day 40-42: Refactor webviews to use components
- Day 43-45: Documentation & cleanup

**Total estimated time:** 6-7 weeks

---

## Benefits Summary

### Effect-TS Benefits

✅ **Unified error handling** - All errors typed (FetchError, DatabaseError, etc.)
✅ **Dependency injection** - Services testable, swappable
✅ **Retry/timeout/fallback** - Built into every operation
✅ **Structured concurrency** - Control async execution
✅ **Resource safety** - Automatic cleanup
✅ **Type-safe composition** - Chain operations safely

### Preact + Signals Benefits

✅ **JSX templates** - Declarative UI (vs manual DOM)
✅ **Fine-grained reactivity** - Only re-render what changed
✅ **Type-safe components** - Props validated at compile-time
✅ **Better DX** - Faster iteration, less boilerplate
✅ **Performance** - Signals avoid virtual DOM overhead
✅ **Global state** - Accessible from Effect programs

### Combined Benefits

✅ **Separation of concerns** - Effect = logic, Signals = UI state
✅ **Testability** - Mock Effect layers, test components in isolation
✅ **Maintainability** - Consistent patterns across all features
✅ **Scalability** - Add features without increasing complexity
✅ **Developer velocity** - Less time debugging, more time building

---

## Risks & Mitigations

### Risk 1: Learning Curve

**Impact:** Team needs to learn Effect-TS concepts (Effect, Layer, Service)
**Mitigation:**

- Start with Phase 1 (server) - highest ROI, isolated scope
- Pair programming sessions
- Document patterns as we build them

### Risk 2: Build Complexity

**Impact:** Adding Preact JSX transform increases build config complexity
**Mitigation:**

- Use Preact's official Vite plugin (well-tested)
- Keep webview builds separate from main app
- Document build process thoroughly

### Risk 3: Migration Disruption

**Impact:** Migrating live features could break existing functionality
**Mitigation:**

- Migrate one feature at a time
- Keep old and new implementations side-by-side during transition
- Feature flags for gradual rollout
- Comprehensive testing before replacing

### Risk 4: Effect-TS Bundle Size

**Impact:** Effect runtime adds ~50KB to bundle
**Mitigation:**

- Not a concern (already shipping VSCode workbench + Postgres WASM)
- Tree-shaking removes unused Effect modules
- Better architecture > marginal bundle size

---

## Success Metrics

### Code Quality

- [ ] All HTTP calls use Effect services (no raw fetch)
- [ ] All errors are typed Effect errors
- [ ] All async operations have timeout/retry
- [ ] All dependencies injected via Layers
- [ ] All webviews use Preact + Signals

### Developer Experience

- [ ] New features use Effect + Preact by default
- [ ] Reduced debugging time (structured errors)
- [ ] Faster iteration (HMR works with Preact)
- [ ] Easier testing (mock Effect layers)

### Performance

- [ ] Webviews preserve scroll/focus state on updates
- [ ] No unnecessary DOM re-renders
- [ ] Network requests retry automatically
- [ ] Operations timeout gracefully

---

## Next Steps

1. **Review this plan** - Discuss timeline, scope, priorities
2. **Set up Effect + Preact scaffolding** - Basic project structure
3. **Start Phase 1** - Migrate one playground endpoint as proof-of-concept
4. **Iterate** - Gather feedback, adjust approach

---

## References

### Effect-TS

- [Effect Docs](https://effect.website/docs/introduction)
- [Effect Services](https://effect.website/docs/context-management/services)
- [Effect Error Handling](https://effect.website/docs/error-management/expected-errors)

### Preact

- [Preact Docs](https://preactjs.com/guide/v10/getting-started)
- [Preact Signals](https://preactjs.com/guide/v10/signals)
- [Preact + TypeScript](https://preactjs.com/guide/v10/typescript)

### VSCode Extension Development

- [Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [Extension Samples](https://github.com/microsoft/vscode-extension-samples)

---

**Last Updated:** 2025-01-20
**Status:** Draft - Awaiting Review
