before(() => {
  cy.serverCommand("clearTestUsers");
});

describe('workbench basics', () => {
  it('logs in with test helper', () => {
    cy.login({ verified: true });
    // extract user from INITIAL_DATA
    cy.window().its('__INITIAL_DATA__').then((data: { user: { username: string } }) => {
      // oxlint-disable-next-line typescript/no-unused-expressions
      expect(data.user).to.exist;
      // confirm it exists in the UI
      cy.waitForWorkbench();
      cy.get('footer').should('contain.text', data.user.username);
    })
  });

  it('can create file and execute notebook', () => {
    cy.visit('/');
    cy.waitForWorkbench();

    // Create new file via explorer (use force:true since actions are hidden until hover)
    cy.get('.codicon-new-file[aria-label^="New File"]').click({ force: true });
    cy.get('input[aria-label^="Type file name"]').type('test.sql{enter}');

    // open file - it should open as SQL Notebook
    cy.get('.monaco-list-row').contains('test.sql').dblclick();

    // Wait for notebook to fully load
    cy.contains('SQL Notebook', { timeout: 10000 }).should('exist');

    // Click "+ Code" to add a new code cell in the notebook
    // Use VSCode command to insert a code cell (more reliable than clicking)
    cy.window().then(win => {
      // oxlint-disable-next-line typescript/no-unsafe-return, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-explicit-any
      return (win as any).vscode.commands.executeCommand('notebook.cell.insertCodeCellBelow');
    });

    // Wait for cell editor to appear and type query
    // Find Monaco's input textarea (it's a direct child of .monaco-editor, class is .inputarea or just textarea)
    cy.get('.cell-editor-container .monaco-editor textarea', { timeout: 10000 })
      .first()
      .type('SELECT 1 AS test_column;', { force: true });

    // Run all cells
    cy.get('.codicon-notebook-execute-all').first().click({ force: true });

    // Check output contains our result
    cy.get('.notebook-output', { timeout: 15000 }).should('contain.text', 'test_column');
  });
});
