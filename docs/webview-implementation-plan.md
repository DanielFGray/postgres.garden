# Webview Implementation Plan

## Goal
Integrate VSCode webview panels and webview views to create a playground management system that connects to our existing database schema.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     VSCode Workbench UI                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌──────────────────┐         ┌──────────────────────────────┐  │
│  │  Sidebar View    │         │    Editor Panel               │  │
│  │  (Webview View)  │         │    (Webview Panel)            │  │
│  │                  │         │                               │  │
│  │ • List playgrounds│        │ • Edit playground content     │  │
│  │ • Filter/search  │         │ • Preview rendering           │  │
│  │ • Create/fork    │         │ • Save state to DB            │  │
│  │ • Privacy toggle │         │ • Metadata editing            │  │
│  └──────────────────┘         └──────────────────────────────┘  │
│         │                                    │                   │
│         └────────────┬───────────────────────┘                   │
│                      │                                           │
└──────────────────────┼───────────────────────────────────────────┘
                       │ VSCode Extension API
                       │
            ┌──────────▼──────────┐
            │   Extension Host    │
            │  (playground ext)   │
            └──────────┬──────────┘
                       │ HTTP/REST
            ┌──────────▼──────────┐
            │   Server (Bun)      │
            │   /api/playgrounds  │
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │   PostgreSQL DB     │
            │   • playgrounds     │
            │   • users           │
            └─────────────────────┘
```

## Database Schema Integration

### Playgrounds Table (existing)
- `id` - unique identifier
- `user_id` - owner reference
- `fork_id` - fork parent reference
- `privacy` - public/private/secret enum
- `name` - unique per user
- `description` - text description
- `data` - **JSONB field for webview state**
- `created_at`, `updated_at` - timestamps

### Data JSONB Structure
```typescript
interface PlaygroundData {
  version: string;
  content: {
    files: Array<{
      path: string;
      content: string;
      language: string;
    }>;
    activeFile?: string;
  };
  settings: {
    theme?: string;
    fontSize?: number;
    layout?: 'split' | 'single';
  };
  webviewState?: any; // Custom webview state
}
```

## Implementation Files

### 1. Extension Structure
```
src/features/playground/
├── extension.ts                    # Main extension activation
├── providers/
│   ├── PlaygroundViewProvider.ts   # Sidebar webview view
│   └── PlaygroundPanelProvider.ts  # Editor webview panel
├── services/
│   └── PlaygroundService.ts        # HTTP client for API
├── webview/
│   ├── view/                       # Sidebar UI
│   │   ├── index.html
│   │   ├── main.js
│   │   └── styles.css
│   └── panel/                      # Editor UI
│       ├── index.html
│       ├── main.js
│       └── styles.css
└── types.ts                        # Shared types
```

### 2. Server API Endpoints
```
server/api/
└── playgrounds.ts
    GET    /api/playgrounds           # List user's playgrounds
    POST   /api/playgrounds           # Create new playground
    GET    /api/playgrounds/:id       # Get playground by id
    PUT    /api/playgrounds/:id       # Update playground
    DELETE /api/playgrounds/:id       # Delete playground
    POST   /api/playgrounds/:id/fork  # Fork playground
```

### 3. Webview View (Sidebar)
**Features:**
- List all playgrounds (filterable by privacy)
- Search/filter UI
- Create new playground button
- Click to open in editor panel
- Context menu: Open, Fork, Delete, Share
- Show metadata: name, privacy, updated_at

**Technology:**
- HTML/CSS/Vanilla JS (lightweight)
- VSCode CSS variables for theming
- Codicons for icons

### 4. Webview Panel (Editor)
**Features:**
- Monaco editor integration (or simple textarea)
- Metadata form: name, description, privacy
- Auto-save debouncing
- Fork button
- Share button (copy link)
- Preview pane (optional)

**Technology:**
- HTML/CSS/Vanilla JS
- Monaco editor (since we have it available)
- VSCode CSS variables

## Implementation Phases

### Phase 1: Foundation (THIS SESSION)
- [x] Study existing webview samples
- [ ] Create extension structure in `src/features/playground/`
- [ ] Implement PlaygroundService (HTTP client)
- [ ] Create basic types and interfaces
- [ ] Register extension in package.json

### Phase 2: Webview View (Sidebar)
- [ ] Implement PlaygroundViewProvider
- [ ] Create sidebar HTML/CSS/JS
- [ ] Wire up list playgrounds API
- [ ] Add create playground functionality
- [ ] Test messaging between view and extension

### Phase 3: Webview Panel (Editor)
- [ ] Implement PlaygroundPanelProvider
- [ ] Create editor HTML/CSS/JS
- [ ] Integrate simple text editor
- [ ] Wire up save/load from API
- [ ] Add auto-save with debouncing

### Phase 4: Server API
- [ ] Create /api/playgrounds endpoints
- [ ] Implement CRUD operations
- [ ] Add authentication/authorization
- [ ] Test with extension

### Phase 5: Advanced Features
- [ ] Fork functionality
- [ ] Share URLs
- [ ] Privacy controls
- [ ] Search/filter
- [ ] Preview rendering

## Key Design Decisions

### State Management
- **Source of truth**: PostgreSQL database
- **Client cache**: Extension keeps in-memory cache
- **Auto-save**: Debounced writes (2s after last change)
- **Conflict resolution**: Last-write-wins (for MVP)

### Security
- Content Security Policy with nonces
- `webview.asWebviewUri()` for all resources
- Row-level security in database
- Session-based auth via cookies

### Performance
- Lazy load playground list (paginated)
- Only load full content when opened
- Debounced auto-save
- IndexedDB cache for offline (future)

### User Experience
- Consistent with VSCode patterns
- Keyboard shortcuts
- Context menus
- Status bar integration
- Notifications for errors

## Testing Strategy
1. Manual testing in dev mode
2. Test both webview types independently
3. Test messaging flow
4. Test API integration
5. Test with multiple users/privacy levels

## Future Enhancements
- Real-time collaboration
- Version history
- Comments/annotations
- Marketplace for public playgrounds
- Import/export
- Multiple file support per playground
