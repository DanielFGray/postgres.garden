# Server-Side Data Injection Setup

This project now supports server-side rendering (SSR) of the HTML shell with embedded JSON data, eliminating the data fetching waterfall.

## Architecture

- **Development**: Vite dev server with custom plugin for data injection
- **Production**: Bun server serves pre-built Vite assets with data injection
- **Backend Runtime**: Bun (dev uses Vite's Node.js server under the hood)
- **Frontend**: Unchanged - just reads from `window.__INITIAL_DATA__`

## How It Works

### Development Mode

1. `server/httpapi/webServer.ts` creates a Vite dev server bridge
2. The plugin uses Vite's `transformIndexHtml` hook to inject data
3. Data is fetched via `getInitialData()` and embedded as `<script>window.__INITIAL_DATA__ = {...}</script>`
4. Vite handles all module transformation, HMR, and serving with correct MIME types

### Production Mode

1. `server/httpapi/webServer.ts` serves pre-built assets from `/dist`
2. For HTML requests, it injects data before serving
3. Static assets (JS, CSS, images) are served directly

## Usage

### Development

```bash
# Start dev server with SSR data injection
bun run dev

# Traditional Vite-only dev server (without SSR)
bun run dev:vite
```

The dev server runs on `http://localhost:3000` by default.

### Production

```bash
# Build the frontend assets
bun run build

# Start production server
bun run start
```

The production server runs on `http://localhost:3000` by default.

### Environment Variables

- `PORT` - Server port (default: 3000)
- `HOST` - Server host (default: 0.0.0.0)
- `NODE_ENV` - Set to 'production' for production mode

## Customizing Data Injection

Edit `server/data.ts` to customize what data gets injected:

```typescript
export async function getInitialData(): Promise<InitialData> {
  // Add your database queries here
  const user = await db.users.findOne(...)
  const projects = await db.projects.findMany(...)

  return {
    timestamp: Date.now(),
    environment: process.env.NODE_ENV || 'development',
    user,
    projects,
    // ... your data
  }
}
```

Update the `InitialData` interface to match your data structure.

## Accessing Data in Frontend

```typescript
// Type-safe access to server-injected data
const initialData = window.__INITIAL_DATA__;

if (initialData) {
  console.log("Server provided:", initialData);
  // Use the data in your app initialization
}
```

See `src/example-initial-data-usage.ts` for more examples.

## Server Files

- `server/index.ts` - Entry point (routes to dev/prod)
- `server/httpapi/webServer.ts` - Unified dev/prod web server with SSR injection
- `server/data.ts` - Data fetching logic (customize this!)

## Switching to Effect

To use Effect instead of Elysia:

1. Replace Elysia imports with your Effect HTTP server
2. Keep the same data injection pattern
3. Update `server/httpapi/webServer.ts` accordingly

The core pattern remains the same - fetch data, inject into HTML.
