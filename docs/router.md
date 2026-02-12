# Frontend Router Implementation

## Overview

The application now uses the **Navigation API** (with polyfill) for client-side routing. This provides a modern, standards-based routing solution that integrates seamlessly with the existing SSR architecture.

## Route Structure

```
/                          → Home/landing page
/p/:id                     → Playground (loads latest commit)
/p/:id/c/:commit           → Specific commit in a playground
```

### Examples

```
/                                     → Home
/p/my-sql-playground                  → Playground "my-sql-playground"
/p/my-sql-playground/c/abc123         → Commit "abc123" in playground
```

## Architecture

### Client-Side (Frontend)

**Files:**

- `src/routes.ts` - Route definitions, path parsing, and URL building
- `src/router.ts` - Navigation API router implementation
- `src/features/router.ts` - Router initialization and integration

**Flow:**

1. Navigation API polyfill loaded (`@virtualstate/navigation/polyfill`)
2. Router intercepts all navigate events via `navigation.addEventListener("navigate")`
3. Routes parsed using URLPattern
4. Route changes trigger `onRouteChange` handler
5. Browser history managed automatically

**Key Features:**

- Intercepts all navigation types (links, `window.location`, back/forward)
- Promise-based navigation with `committed` and `finished` states
- Per-route state management via Navigation API
- Full TypeScript support

### Server-Side (SSR)

**Files:**

- `server/data.ts` - Route parsing and data fetching
- `server/dev.ts` - Development server with route-aware data injection
- `server/prod.ts` - Production server with route-aware data injection

**Flow:**

1. Server receives request with pathname
2. `parseRoute()` determines route type and extracts params
3. Data fetched based on route (playground, commit, etc.)
4. Data injected into HTML via `window.__INITIAL_DATA__`
5. Client reads initial data and hydrates without waterfall

**Key Features:**

- No data fetching waterfall (data embedded in HTML)
- Route-specific data loading (playgrounds, commits)
- Clean separation of concerns

## API

### Route Parsing

```typescript
import { parseRoute } from "./routes";

const route = parseRoute("/p/123/c/abc");
// {
//   type: 'commit',
//   params: { playgroundId: '123', commitId: 'abc' },
//   path: '/p/123/c/abc'
// }
```

### Building Paths

```typescript
import { buildPath } from "./routes";

buildPath("home", {});
// '/'

buildPath("playground", { playgroundId: "123" });
// '/p/123'

buildPath("commit", { playgroundId: "123", commitId: "abc" });
// '/p/123/c/abc'
```

### Programmatic Navigation

```typescript
// Access router globally (dev/debug)
window.__router.navigate("playground", { playgroundId: "123" });
window.__router.navigate("commit", { playgroundId: "123", commitId: "abc" });

// Or use Navigation API directly
window.navigation.navigate("/p/123");
window.navigation.navigate("/p/123/c/abc");

// History navigation
window.navigation.back();
window.navigation.forward();
```

### Route Change Handling

The router fires `onRouteChange` whenever a navigation is committed:

```typescript
// See src/features/router.ts
createRouter({
  onRouteChange: async (route) => {
    switch (route.type) {
      case "home":
        // Handle home
        break;
      case "playground":
        // Load playground (route.params.playgroundId)
        break;
      case "commit":
        // Load commit (route.params.playgroundId, route.params.commitId)
        break;
    }
  },
});
```

## Initial Data Structure

The server injects route-aware data into `window.__INITIAL_DATA__`:

```typescript
interface InitialData {
  timestamp: number;
  environment: string;
  route: {
    type: "home" | "playground" | "commit";
    playgroundId?: string;
    commitId?: string;
  };
  user?: {
    id: string;
    username: string;
    role: string;
    isVerified: boolean;
  };
  playground?: {
    id: string;
    name: string;
    description: string;
    privacy: string;
    createdAt: number;
  };
  commit?: {
    id: string;
    timestamp: number;
    message: string;
    files: WorkspaceFile[];
  };
}
```

## Browser Support

The Navigation API polyfill (`@virtualstate/navigation`) supports:

- ✅ Node.js 16+
- ✅ Deno 1.17+
- ✅ Bun 0.1.11+
- ✅ Chromium 98+ (native support in 102+)
- ✅ Firefox 94+
- ✅ Safari/WebKit 15.4+

## Testing

Run route parsing tests:

```bash
bun test-routes.ts
```

## Next Steps

### Immediate TODOs

1. **Workspace Switching**: Implement actual workspace loading in `onRouteChange` handler
2. **Loading States**: Add loading indicators during navigation
3. **Error Handling**: Handle 404s and invalid playground/commit IDs
4. **State Preservation**: Save/restore editor state per route

### Future Enhancements

1. **Nested Routes**: Add support for `/p/:id/c/:commit/files/:path`
2. **Query Params**: Support query params for filters, search, etc.
3. **State Persistence**: Use Navigation API's state management for undo/redo
4. **Prefetching**: Prefetch data for likely next routes
5. **Breadcrumbs**: Add breadcrumb navigation UI

## Migration Notes

### Before (Query Params)

```
/?locale=en
```

### After (Path-Based)

```
/p/123/c/abc?locale=en
```

Query params work for configuration options (`?locale`, etc.), but the primary navigation is path-based.

## References

- [Navigation API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API)
- [@virtualstate/navigation](https://github.com/virtualstate/navigation)
- [URLPattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API)
