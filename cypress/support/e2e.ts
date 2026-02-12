// ***********************************************************
// This example support/e2e.ts is processed and
// loaded automatically before your test files.
//
// This is a great place to put global configuration and
// behavior that modifies Cypress.
//
// You can change the location of this file or turn off
// automatically serving support files with the
// 'supportFile' configuration option.
//
// You can read more here:
// https://on.cypress.io/configuration
// ***********************************************************

// Import commands.js using ES2015 syntax:
import "./commands";

// Alternatively you can use CommonJS syntax:
// require('./commands')

// Global configuration for Cypress
Cypress.on("uncaught:exception", (err) => {
  // Returning false here prevents Cypress from failing the test
  // This is useful for third-party code that might throw errors
  // You may want to customize this based on your needs
  console.error("Uncaught exception:", err);

  // Don't fail tests on uncaught exceptions from the application
  // Adjust this logic based on your testing needs
  return false;
});
