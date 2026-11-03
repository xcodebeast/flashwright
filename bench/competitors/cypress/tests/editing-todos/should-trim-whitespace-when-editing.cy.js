beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Editing Todos", () => {
  it("should trim whitespace when editing", () => {
    cy.get(".new-todo").type("Original task{enter}");
    cy.contains(".todo-list li label", /^Original task$/).should("be.visible");
    cy.get(".todo-list li label").dblclick();
    cy.get(".todo-list li .edit").clear().type("   Edited task   ");
    cy.get(".todo-list li .edit").should('have.value', "   Edited task   ");
    cy.get(".todo-list li .edit").type("{enter}");
    cy.contains(".todo-list li label", /^Edited task$/).should("be.visible");
  });
});
