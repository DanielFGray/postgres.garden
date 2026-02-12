# Cypress E2E Testing Setup

This directory contains the Cypress end-to-end testing infrastructure for the Postgres Garden project.

## Directory Structure

```
cypress/
├── e2e/              # Test files go here (*.cy.ts)
├── fixtures/         # Test data and fixtures
├── support/          # Support files and custom commands
│   ├── commands.ts   # Custom Cypress commands
│   └── e2e.ts        # Global configuration and setup
└── screenshots/      # Auto-generated screenshots (gitignored)
└── videos/           # Auto-generated test videos (gitignored)
```

## Running Tests

### Interactive Mode (Cypress UI)

```bash
bun run cypress:open
```

This opens the Cypress Test Runner UI where you can select and run tests interactively.

### Headless Mode

```bash
bun run cypress:run
# or
bun run test:e2e
```

This runs all tests in headless mode, suitable for CI/CD pipelines.

## Configuration

The main configuration is in `cypress.config.ts` at the project root:

- **Base URL**: http://localhost:3000 (dev server)
- **Viewport**: 1280x720
- **Video Recording**: Disabled by default
- **Retries**: 2 attempts in headless mode, 0 in interactive mode
- **Timeouts**: Extended for VSCode workbench loading
  - Default command timeout: 30s
  - Page load timeout: 2min

## Testing VSCode Workbench

Since this is a **full VSCode workbench** (not a simple Monaco editor), testing requires special considerations:

### ⚠️ Important: Workbench Loading

The workbench loads 300+ VSCode extension packages and initializes multiple services. This can take 30-60 seconds on first load.

**Always wait for the workbench to be ready:**

```typescript
describe("My Test Suite", () => {
  beforeEach(() => {
    cy.visit("/");
    cy.waitForWorkbench(); // Wait for workbench to fully initialize
  });

  it("should do something", () => {
    // Your test code here
  });
});
```

### Custom VSCode Commands

We've added custom Cypress commands specifically for testing the VSCode workbench:

#### `cy.waitForWorkbench()`

Waits for the VSCode workbench to be fully initialized and ready. Returns the VSCode API instance.

```typescript
cy.visit("/");
cy.waitForWorkbench();
```

#### `cy.vscode()`

Gets the VSCode API instance. Automatically waits for workbench to be ready.

```typescript
cy.vscode().then((vscode) => {
  vscode.window.showInformationMessage("Hello!");
});
```

#### `cy.executeVSCodeCommand(commandId, ...args)`

Executes a VSCode command by name.

```typescript
cy.executeVSCodeCommand("server-sync.commit");
cy.executeVSCodeCommand("workbench.action.files.newUntitledFile");
```

#### `cy.createVSCodeFile(path, content)`

Creates a file in the workspace using the VSCode API.

```typescript
cy.createVSCodeFile("/test.txt", "Hello World");
```

#### `cy.readVSCodeFile(path)`

Reads a file from the workspace using the VSCode API. Returns the file content as a string.

```typescript
cy.readVSCodeFile("/test.txt").should("equal", "Hello World");
```

#### `cy.deleteVSCodeFile(path)`

Deletes a file from the workspace using the VSCode API.

```typescript
cy.deleteVSCodeFile("/test.txt");
```

#### `cy.waitForNotification(message, options?)`

Waits for a notification message to appear in the workbench.

```typescript
cy.waitForNotification("Workspace synced");
cy.waitForNotification(/synced/i, { timeout: 15000 });
```

## Writing Tests

Create test files in the `cypress/e2e/` directory with the `.cy.ts` extension:

```typescript
/// <reference types="cypress" />

describe("My Test Suite", () => {
  beforeEach(() => {
    cy.visit("/");
    cy.waitForWorkbench();
  });

  it("should create and read a file", () => {
    // Create a file
    cy.createVSCodeFile("/example.txt", "Test content");
    
    // Verify it was created
    cy.readVSCodeFile("/example.txt").should("equal", "Test content");
    
    // Execute a command
    cy.executeVSCodeCommand("server-sync.commit");
    
    // Wait for notification
    cy.waitForNotification("Workspace synced");
  });
});
```

## Best Practices

### ✅ DO:

- Always call `cy.waitForWorkbench()` after `cy.visit()`
- Use the custom VSCode commands (`cy.createVSCodeFile`, etc.)
- Wait for actual events instead of arbitrary timeouts
- Use `cy.waitForNotification()` to verify user-visible outcomes

### ❌ DON'T:

- Don't use `cy.wait(5000)` - wait for actual signals instead
- Don't access `window.vscode` directly - use `cy.vscode()` instead
- Don't assume the workbench is ready after page load
- Don't use short timeouts - the workbench needs time to initialize

## Troubleshooting

### Test times out before workbench loads

**Solution**: The workbench can take 30-60s to load on first visit. The `cy.waitForWorkbench()` command has a 2-minute timeout. If it's still timing out:

1. Make sure the dev server is running
2. Check browser console for errors
3. Try increasing the timeout in `cypress.config.ts`

### "VSCode API not available" error

**Solution**: You're trying to access the VSCode API before it's ready. Always use `cy.waitForWorkbench()` first:

```typescript
// ❌ Wrong
cy.visit("/");
cy.window().then(win => win.vscode); // May be undefined

// ✅ Right
cy.visit("/");
cy.waitForWorkbench(); // Waits for vscode to be ready
```

### File operations fail

**Solution**: Make sure you're using the VSCode API commands after the workbench is ready:

```typescript
cy.visit("/");
cy.waitForWorkbench();
cy.createVSCodeFile("/test.txt", "content"); // Now it works
```

## Notes

- Make sure the dev server is running on port 3000 before running tests
- The `e2e.ts` file catches uncaught exceptions to prevent flaky tests from third-party code
- Custom commands can be added to `support/commands.ts`
- The VSCode workbench uses IndexedDB for persistence - tests may affect each other if not properly isolated
