// Fixture for no-command-string-literals. The main scan skips this directory,
// so the invalid cases below are here to be matched on purpose.
declare const api: {
  registerCommand: (id: string, run: () => void) => void;
  executeCommand: (id: string, argument?: string) => void;
};
declare const PLAYGROUND_OPEN: string;

// Valid: the id comes from a constant, and a message in the body is not an id.
api.registerCommand(PLAYGROUND_OPEN, () => api.executeCommand(PLAYGROUND_OPEN));
api.registerCommand(PLAYGROUND_OPEN, () => api.executeCommand(PLAYGROUND_OPEN, "an argument"));
api.registerCommand(PLAYGROUND_OPEN, () => {
  throw new Error("a message, not a command id");
});

// Invalid: the id itself is a literal.
api.registerCommand("playground.open", () => {});
api.executeCommand("playground.open");
api.executeCommand("playground.open", "an argument");
