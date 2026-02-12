# Frontend Effect Integration Plan

**Goal**: Integrate Effect-TS into the frontend workbench to manage initialization, create a FiberSet for command execution, and use runFork for custom commands.

**Inspiration**: [Effect Days 2025 Workshop - Express Layer Pattern](https://github.com/Effect-TS/effect-days-2025-workshop/blob/main/src/demos/section-2/express-layer-01.ts)

---

## Architecture Overview

### Current Architecture (Promise-based)

```
index.html
  └─→ src/loader.ts (top-level await)
       ├─→ imports features (side effects: registerExtension)
       │    └─→ void getApi().then(vscode => { /* register commands */ })
       └─→ await setupWorkbench()
            └─→ await initializeMonacoService()
```

**Problems:**
- No structured concurrency (commands run as unmanaged promises)
- No cancellation support
- No timeout/retry for operations
- Hard to test (no dependency injection)
- Error handling inconsistent (throw strings, try/catch)

### Target Architecture (Effect-based)

```
index.html
  └─→ src/loader.ts
       └─→ Effect.runFork(program.pipe(Effect.provide(MainLayer)))
            ├─→ Workbench Service (scoped)
            │    ├─→ initializeMonacoService (acquireRelease)
            │    └─→ FiberSet.makeRuntime() → runFork
            │
            └─→ Extension Layers (Layer.scopedDiscard)
                 ├─→ PlaygroundExtension
                 ├─→ ServerSyncExtension
                 ├─→ AuthExtension
                 └─→ PostgresExtension
                      └─→ registerCommand(id, () => runFork(program))
```

**Benefits:**
- ✅ Structured concurrency via FiberSet
- ✅ Automatic cleanup when scope closes
- ✅ Commands can be cancelled/interrupted
- ✅ Timeout/retry built-in
- ✅ Dependency injection for testing
- ✅ Consistent error handling

---

## Key Patterns from Workshop

### Pattern 1: Scoped Service with FiberSet.makeRuntime

```typescript
class ExpressApp extends Effect.Service<ExpressApp>()("ExpressApp", {
  scoped: Effect.gen(function* () {
    const scope = yield* Effect.scope;
    
    // Initialize Express with resource management
    yield* Effect.acquireRelease(
      Effect.sync(() => app.listen(3000)),
      (server) => Effect.async(resume => server.close(() => resume(Effect.void)))
    );
    
    // Create scoped runFork - CRITICAL PATTERN!
    const runFork = yield* FiberSet.makeRuntime<R>().pipe(
      Scope.extend(scope)  // ← Ties FiberSet to service scope
    );
    
    return { app, addRoute } as const;
  })
}) {}
```

**Maps to Workbench:**
- `app.listen()` → `initializeMonacoService()`
- `addRoute()` → command registration helper
- `runFork` → runs commands as managed fibers

### Pattern 2: Layer.scopedDiscard for Side Effects

```typescript
const Routes = Layer.scopedDiscard(Effect.gen(function* () {
  const { addRoute } = yield* ExpressApp;
  
  // Register routes (side effects, no return value)
  yield* addRoute("get", "/hello", handler);
  yield* addRoute("post", "/users", handler);
}));
```

**Maps to Extensions:**
- Each extension becomes a `Layer.scopedDiscard`
- Accesses `Workbench` service to get `runFork`
- Registers VSCode commands as side effects

### Pattern 3: Layer Composition & Launch

```typescript
const MainLayer = Layer.mergeAll(
  ExpressApp.Default,
  Routes,
  TracingLayer
);

program.pipe(
  Effect.provide(MainLayer),
  Layer.launch,
  NodeRuntime.runMain
);
```

**Maps to Loader:**
- Compose all extension layers
- Browser uses `Effect.runFork` instead of `NodeRuntime.runMain`
- Program runs `Effect.never` to stay alive

---

## File Structure

### New Files to Create

```
src/
├── services/
│   ├── Workbench.ts          # Main workbench service with FiberSet
│   ├── VSCodeApi.ts          # Wrapper for getApi() promises
│   ├── HttpClient.ts         # Effect wrapper for api-client
│   └── PlaygroundService.ts  # Effect service (replaces class)
│
└── workbench/
    └── commands.ts           # Command registration helpers
```

### Files to Modify

```
src/
├── loader.ts                 # Replace await with Effect.runFork
├── setup.workbench.ts        # Convert to Effect.Service
└── features/
    ├── playground/
    │   └── extension.ts      # Convert to Layer.scopedDiscard
    ├── serverSync.ts         # Convert to Layer.scopedDiscard
    ├── postgres.ts           # Convert to Layer.scopedDiscard
    └── auth.ts              # Convert to Layer.scopedDiscard
```

---

## Migration Phases

### Phase 1: Core Infrastructure (Foundation)

**Goal**: Create Effect runtime and service layer without breaking existing code

**Tasks:**
1. Create `src/services/Workbench.ts` - scoped service with FiberSet
2. Create `src/workbench/commands.ts` - helper for Effect command registration
3. Modify `src/loader.ts` - wrap in Effect runtime with `runFork`
4. Keep `setupWorkbench()` as-is initially (called via `Effect.tryPromise`)

**Validation:**
- ✅ App still loads
- ✅ Workbench initializes normally
- ✅ Extensions still activate
- ✅ Commands still work (via old pattern)

**Estimated time**: 2-3 hours

---

### Phase 2: Single Extension Migration (Proof of Concept)

**Goal**: Migrate one extension to prove the pattern works

**Target**: `src/features/playground/extension.ts` (smallest, 268 lines)

**Tasks:**
1. Create `src/services/VSCodeApi.ts` - wrap `getApi()` promise
2. Convert `PlaygroundService` class → Effect Service
3. Convert playground extension → `Layer.scopedDiscard`
4. Migrate commands to use `runFork` from `Workbench` service
5. Test all playground commands work

**Example Command Migration:**

**Before:**
```typescript
void getApi().then(async (vscode) => {
  vscode.commands.registerCommand(PLAYGROUND_CREATE, async () => {
    const name = await vscode.window.showInputBox({ prompt: "Name" });
    const playground = await service.createPlayground({ name });
    // ... navigate
  });
});
```

**After:**
```typescript
export const PlaygroundExtension = Layer.scopedDiscard(
  Effect.gen(function* () {
    const { runFork } = yield* Workbench;
    const vscode = yield* VSCodeApi;
    const service = yield* PlaygroundService;
    
    vscode.commands.registerCommand(PLAYGROUND_CREATE, () => {
      runFork(Effect.gen(function* () {
        const name = yield* Effect.promise(() =>
          vscode.window.showInputBox({ prompt: "Name" })
        );
        const playground = yield* service.create({ name });
        yield* Effect.logInfo(`Created: ${playground.id}`);
      }));
    });
  })
);
```

**Validation:**
- ✅ PLAYGROUND_CREATE command works
- ✅ PLAYGROUND_OPEN command works
- ✅ PLAYGROUND_REFRESH_METADATA works
- ✅ All playground operations succeed
- ✅ No regressions in other features

**Estimated time**: 4-6 hours

---

### Phase 3: Remaining Extensions Migration

**Goal**: Migrate all extensions to Effect layers

**Order** (smallest to largest):
1. `src/features/ai.ts` (~30 lines, 1 command)
2. `src/features/authStatusBar.ts` (~80 lines, status bar only)
3. `src/features/auth.ts` (~200 lines, auth provider)
4. `src/features/postgres.ts` (~400 lines, 4 commands)
5. `src/features/serverSync.ts` (~1046 lines, 7 commands) - LARGEST

**Per-Extension Tasks:**
1. Wrap `getApi()` in Effect Service (or reuse shared `VSCodeApi`)
2. Convert to `Layer.scopedDiscard`
3. Migrate command handlers to use `runFork`
4. Test all commands

**Validation per Extension:**
- ✅ All commands registered
- ✅ All commands execute successfully
- ✅ No memory leaks
- ✅ HMR still works

**Estimated time**: 2-3 days

---

### Phase 4: Enhance with Effect Features

**Goal**: Add timeout, retry, error handling to commands

**Enhancements:**
1. Add timeout to long-running operations
2. Add retry logic for network requests
3. Add structured error types
4. Add telemetry/logging
5. Add command cancellation UI

**Example Enhancement:**
```typescript
const createPlayground = (name: string) =>
  Effect.gen(function* () {
    const service = yield* PlaygroundService;
    
    const playground = yield* service.create({ name }).pipe(
      Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
      Effect.timeout("10 seconds"),
      Effect.catchTag("TimeoutException", () =>
        Effect.fail(new PlaygroundTimeoutError({ name }))
      ),
      Effect.tap(() => Effect.logInfo(`Created playground: ${name}`))
    );
    
    return playground;
  });
```

**Estimated time**: 2-3 days

---

## Implementation Details

### 1. Workbench Service

**File**: `src/services/Workbench.ts`

**Purpose**: 
- Initialize Monaco/VSCode workbench
- Provide scoped `runFork` for command execution
- Manage FiberSet lifecycle

**Key APIs:**
- `Effect.Service<T>()("Name", { scoped: ... })` - Service definition
- `Effect.scope` - Access current scope
- `FiberSet.makeRuntime()` - Create runFork function
- `Scope.extend(scope)` - Tie FiberSet to service scope
- `Effect.acquireRelease` - Manage workbench initialization

**Pattern:**
```typescript
export class Workbench extends Effect.Service<Workbench>()("Workbench", {
  scoped: Effect.gen(function* () {
    const scope = yield* Effect.scope;
    
    // Setup DOM
    const container = document.createElement("div");
    // ...
    
    // Initialize Monaco with resource management
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => initializeMonacoService(...),
        catch: (e) => new WorkbenchInitError({ cause: e })
      }),
      () => Effect.logInfo("Workbench cleanup")
    );
    
    // Create scoped runFork
    const runFork = yield* FiberSet.makeRuntime<never>().pipe(
      Scope.extend(scope)
    );
    
    yield* Effect.logInfo("Workbench ready");
    
    return { runFork, container } as const;
  })
}) {}
```

---

### 2. VSCodeApi Service

**File**: `src/services/VSCodeApi.ts`

**Purpose**: Wrap `getApi()` promises from `registerExtension`

**Options:**

**Option A: Shared VSCodeApi** (if all getApi() return same instance)
```typescript
export class VSCodeApi extends Effect.Service<VSCodeApi>()(
  "VSCodeApi",
  {
    effect: Effect.promise(() => {
      // Get any extension's getApi - they should all return the same vscode API
      // This requires importing ONE extension's getApi
      return someGetApi();
    })
  }
) {}
```

**Option B: Per-Extension API** (if different)
```typescript
// Each extension creates its own
const PlaygroundVSCodeApi = Effect.promise(() => playgroundGetApi());
const PostgresVSCodeApi = Effect.promise(() => postgresGetApi());
```

**Recommended**: Start with Option A (shared), split later if needed.

---

### 3. Extension Layers

**Pattern**: Each extension file exports a Layer

```typescript
// src/features/playground/extension.ts
import { Layer, Effect } from "effect";
import { Workbench } from "../../services/Workbench";
import { VSCodeApi } from "../../services/VSCodeApi";

const { getApi } = registerExtension({ ... });

export const PlaygroundExtension = Layer.scopedDiscard(
  Effect.gen(function* () {
    const { runFork } = yield* Workbench;
    const vscode = yield* Effect.promise(() => getApi());
    
    // Register all commands
    vscode.commands.registerCommand(PLAYGROUND_CREATE, () => {
      runFork(createPlaygroundProgram);
    });
    
    vscode.commands.registerCommand(PLAYGROUND_OPEN, (id: number) => {
      runFork(openPlaygroundProgram(id));
    });
    
    // ... more commands
    
    yield* Effect.logInfo("Playground extension activated");
  })
);
```

**Note**: We DON'T need to wrap VSCodeApi as a service if we just call `Effect.promise(() => getApi())` inline. Each extension manages its own `getApi()`.

---

### 4. Loader Integration

**File**: `src/loader.ts`

**Before:**
```typescript
await setupWorkbench();
```

**After:**
```typescript
import { Effect, Layer } from "effect";
import { Workbench } from "./services/Workbench";
import { PlaygroundExtension } from "./features/playground/extension";
import { ServerSyncExtension } from "./features/serverSync";
import { PostgresExtension } from "./features/postgres";
import { AuthExtension } from "./features/auth";

const program = Effect.gen(function* () {
  yield* Effect.logInfo("Workbench initialized and running");
  yield* Effect.never; // Keep runtime alive (browser doesn't exit)
});

const MainLayer = Layer.mergeAll(
  Workbench.Default,
  PlaygroundExtension,
  ServerSyncExtension,
  PostgresExtension,
  AuthExtension
);

program.pipe(
  Effect.provide(MainLayer),
  Effect.runFork
);
```

---

### 5. Command Handler Patterns

**Simple Command** (no args):
```typescript
vscode.commands.registerCommand(PLAYGROUND_REFRESH, () => {
  runFork(Effect.gen(function* () {
    yield* Effect.logInfo("Refreshing...");
    const service = yield* PlaygroundService;
    yield* service.refresh();
  }));
});
```

**Command with Args**:
```typescript
vscode.commands.registerCommand(PLAYGROUND_OPEN, (id: number) => {
  runFork(Effect.gen(function* () {
    const service = yield* PlaygroundService;
    const playground = yield* service.get(id).pipe(
      Effect.timeout("5 seconds"),
      Effect.retry({ times: 2 })
    );
    yield* Effect.logInfo(`Opened: ${playground.name}`);
  }));
});
```

**Command with User Input**:
```typescript
vscode.commands.registerCommand(PLAYGROUND_CREATE, () => {
  runFork(Effect.gen(function* () {
    const vscode = yield* VSCodeApi;
    
    const name = yield* Effect.promise(() =>
      vscode.window.showInputBox({ prompt: "Name" })
    );
    
    if (!name) return yield* Effect.void;
    
    const service = yield* PlaygroundService;
    const playground = yield* service.create({ name });
    
    yield* Effect.logInfo(`Created: ${playground.id}`);
  }));
});
```

**Long-Running Command with Cancellation**:
```typescript
vscode.commands.registerCommand(SERVER_SYNC_COMMIT, () => {
  runFork(Effect.gen(function* () {
    // Show progress
    yield* Effect.log("Starting commit...");
    
    const files = yield* collectFiles().pipe(
      Effect.timeout("30 seconds")
    );
    
    yield* uploadFiles(files).pipe(
      Effect.retry({ times: 3 }),
      Effect.timeout("60 seconds"),
      Effect.onInterrupt(() => 
        Effect.log("Commit cancelled by user")
      )
    );
    
    yield* Effect.log("Commit complete!");
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        const vscode = yield* VSCodeApi;
        vscode.window.showErrorMessage(`Commit failed: ${error}`);
      })
    )
  ));
});
```

---

## Migration Checklist

### Phase 1: Foundation (Do First)

- [ ] Create `src/services/Workbench.ts` with scoped FiberSet
- [ ] Create `src/workbench/commands.ts` helper utilities
- [ ] Modify `src/loader.ts` to use Effect runtime
- [ ] Test: App loads, workbench initializes, extensions activate

### Phase 2: Proof of Concept

- [ ] Migrate `src/features/playground/extension.ts` → Layer
- [ ] Test all playground commands work
- [ ] Test HMR still works
- [ ] Test no memory leaks (FiberSet cleanup)

### Phase 3: Full Migration

- [ ] Migrate `src/features/ai.ts` → Layer
- [ ] Migrate `src/features/authStatusBar.ts` → Layer
- [ ] Migrate `src/features/auth.ts` → Layer
- [ ] Migrate `src/features/postgres.ts` → Layer
- [ ] Migrate `src/features/serverSync.ts` → Layer
- [ ] Test entire app functionality

### Phase 4: Enhancement

- [ ] Add timeout to all commands
- [ ] Add retry to network operations
- [ ] Add structured error types
- [ ] Add command cancellation UI
- [ ] Add Effect.log telemetry

---

## Key Questions & Decisions

### Q1: Should each extension have its own VSCodeApi service?

**Answer**: No, likely share one `VSCodeApi` service since all `getApi()` calls should return the same VSCode API instance.

**Implementation**: Create ONE `VSCodeApi.Live` layer that wraps any extension's `getApi()`.

### Q2: How to handle extension registration (registerExtension)?

**Current**: Each feature file calls `registerExtension` at module scope

```typescript
const { getApi } = registerExtension({ ... });
void getApi().then(vscode => { ... });
```

**Keep it**: `registerExtension` calls can stay at module scope (they're synchronous). Only the `getApi().then()` part becomes Effect.

**Pattern**:
```typescript
// Module scope - stays as-is
const { getApi } = registerExtension({ name: "playground", ... });

// Export as Layer - NEW
export const PlaygroundExtension = Layer.scopedDiscard(
  Effect.gen(function* () {
    const vscode = yield* Effect.promise(() => getApi());
    // ... register commands
  })
);
```

### Q3: How to handle HMR (Hot Module Replacement)?

**Current**: Module-level `subscriptions` array for disposal

```typescript
const subscriptions: vscode.Disposable[] = [];
// ... push disposables
```

**Effect Approach**: Scope handles cleanup automatically!

When scope closes (HMR reload), all:
- Command registrations disposed (via `Effect.addFinalizer`)
- Fibers interrupted
- Resources cleaned up

**No manual subscription management needed!**

### Q4: Should setupWorkbench() become an Effect?

**Two Options:**

**Option A: Keep as Promise** (simpler migration)
```typescript
yield* Effect.tryPromise({
  try: () => setupWorkbench(),
  catch: (e) => new WorkbenchInitError({ cause: e })
});
```

**Option B: Convert to Effect** (more idiomatic)
```typescript
// src/setup.workbench.ts
export const setupWorkbenchEffect = Effect.gen(function* () {
  // ... existing logic but with yield*
  
  yield* Effect.tryPromise({
    try: () => initializeMonacoService(...),
    catch: (e) => new WorkbenchInitError({ cause: e })
  });
});
```

**Recommendation**: Start with Option A, migrate to Option B in Phase 4.

### Q5: How does the FiberSet lifetime work?

**Lifetime hierarchy:**
```
Workbench Service Scope (created by Layer)
  └─→ FiberSet.makeRuntime() extended to scope
       └─→ All command fibers
```

**When scope closes** (page unload, HMR):
1. Workbench finalizers run
2. FiberSet interrupts all running command fibers
3. Each fiber's finalizers run
4. Clean shutdown guaranteed

---

## Critical Code Patterns

### Pattern 1: Scoped Service Definition

```typescript
export class Workbench extends Effect.Service<Workbench>()("Workbench", {
  scoped: Effect.gen(function* () {
    const scope = yield* Effect.scope;
    
    // ... initialization with acquireRelease
    
    const runFork = yield* FiberSet.makeRuntime<never>().pipe(
      Scope.extend(scope)
    );
    
    return { runFork } as const;
  })
}) {}
```

**Key points:**
- `scoped:` creates a new scope for the service
- `yield* Effect.scope` gets the current scope
- `Scope.extend(scope)` ties FiberSet to this scope
- Finalizers run in reverse order when scope closes

### Pattern 2: Layer.scopedDiscard for Side Effects

```typescript
export const PlaygroundExtension = Layer.scopedDiscard(
  Effect.gen(function* () {
    const { runFork } = yield* Workbench;
    
    // Side effects: command registration
    // No return value needed
  })
);
```

**Key points:**
- `scopedDiscard` = scoped effect that returns nothing
- Perfect for registration/initialization side effects
- Cleanup via `Effect.addFinalizer`

### Pattern 3: Effect.promise for Wrapping Promises

```typescript
// Wrap getApi() promise
const vscode = yield* Effect.promise(() => getApi());

// Wrap VSCode API calls
const name = yield* Effect.promise(() =>
  vscode.window.showInputBox({ prompt: "Name" })
);
```

**Key points:**
- `Effect.promise()` for promises that cannot fail
- `Effect.tryPromise()` for promises that can throw
- Use in generators with `yield*`

### Pattern 4: Command with runFork

```typescript
vscode.commands.registerCommand(COMMAND_ID, (...args) => {
  runFork(Effect.gen(function* () {
    // Command logic here
    // Access services via yield*
    // Automatic timeout, error handling, cancellation
  }));
});
```

**Key points:**
- `runFork` returns immediately (fire-and-forget)
- Fiber tracked in FiberSet
- Can be interrupted if scope closes
- Errors logged automatically

---

## Testing Strategy

### Unit Tests (Future)

```typescript
import { Effect, Layer } from "effect";
import { Workbench } from "./services/Workbench";

const MockWorkbench = Layer.succeed(Workbench, {
  runFork: (effect) => Effect.runPromise(effect) // Synchronous for tests
});

test("playground create command", async () => {
  const program = createPlaygroundProgram("test-name");
  
  const result = await Effect.runPromise(
    program.pipe(Effect.provide(MockWorkbench))
  );
  
  expect(result.name).toBe("test-name");
});
```

---

## Risks & Mitigations

### Risk 1: Breaking existing functionality

**Mitigation**: 
- Migrate incrementally (one extension at a time)
- Keep old code alongside new until validated
- Test thoroughly after each migration

### Risk 2: HMR compatibility

**Mitigation**:
- Test HMR after Phase 1
- Ensure scope cleanup doesn't break Vite HMR
- May need to handle scope recreation on HMR

### Risk 3: Learning curve

**Mitigation**:
- Start with simple extension (playground)
- Document patterns as we go
- Reference workshop code and effect-docs.md

### Risk 4: Bundle size

**Impact**: Effect runtime ~50KB
**Mitigation**: Already shipping full VSCode workbench (MBs), not a concern

---

## Success Criteria

### Phase 1 (Foundation)
- [x] Effect runtime running in loader.ts
- [x] Workbench service with FiberSet initialized
- [x] App loads without errors
- [x] Existing commands still work

### Phase 2 (Proof of Concept)
- [ ] One extension fully migrated to Layer
- [ ] All migrated commands work correctly
- [ ] Commands run as managed fibers
- [ ] No memory leaks detected

### Phase 3 (Full Migration)
- [ ] All extensions migrated to Layers
- [ ] All commands use runFork
- [ ] HMR still works
- [ ] No regressions

### Phase 4 (Enhancement)
- [ ] Timeout added to long operations
- [ ] Retry added to network calls
- [ ] Structured error handling
- [ ] Command cancellation works

---

## Next Steps

### Immediate Actions:

1. **Create foundation services**:
   - `src/services/Workbench.ts`
   - `src/workbench/commands.ts` (helper utilities)

2. **Modify loader.ts**:
   - Import Effect, Layer, Workbench
   - Replace `await setupWorkbench()` with Effect runtime
   - Use `Effect.runFork` to launch

3. **Test foundation**:
   - App loads
   - Workbench initializes
   - Extensions activate (old pattern still works)

4. **Migrate one extension**:
   - Start with `playground/extension.ts`
   - Convert to Layer.scopedDiscard
   - Test all commands

5. **Iterate**:
   - Migrate remaining extensions
   - Add enhancements
   - Document patterns

---

## Code Snippets for Quick Reference

### Initialize in loader.ts
```typescript
const MainLayer = Layer.mergeAll(
  Workbench.Default,
  PlaygroundExtension,
  ServerSyncExtension
);

Effect.void.pipe(
  Effect.provide(MainLayer),
  Effect.runFork
);
```

### Extension Layer Template
```typescript
const { getApi } = registerExtension({ ... });

export const MyExtension = Layer.scopedDiscard(
  Effect.gen(function* () {
    const { runFork } = yield* Workbench;
    const vscode = yield* Effect.promise(() => getApi());
    
    vscode.commands.registerCommand(COMMAND_ID, () => {
      runFork(commandProgram);
    });
  })
);
```

### Command Program Template
```typescript
const commandProgram = Effect.gen(function* () {
  const vscode = yield* VSCodeApi; // or use closure
  const service = yield* MyService;
  
  const input = yield* Effect.promise(() =>
    vscode.window.showInputBox({ prompt: "..." })
  );
  
  const result = yield* service.doSomething(input).pipe(
    Effect.timeout("10 seconds"),
    Effect.retry({ times: 3 })
  );
  
  yield* Effect.logInfo(`Success: ${result}`);
});
```

---

## References

- **Workshop Code**: https://github.com/Effect-TS/effect-days-2025-workshop/blob/main/src/demos/section-2/express-layer-01.ts
- **Effect Docs**: docs/effect-docs.md
- **Migration Plan**: docs/effect-preact-migration-plan.md
- **Effect Website**: https://effect.website/docs

---

**Status**: Planning Phase
**Last Updated**: 2025-11-25
**Next Action**: Implement Phase 1 - Foundation
