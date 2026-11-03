beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Editing Todos", () => {
  it("should-cancel-edit-on-escape", () => {
    cy.get(".new-todo").type("Original text{enter}");
    cy.contains(".todo-list li label", /^Original text$/).should("be.visible");
    cy.get(".todo-list li label").dblclick();
    cy.get(".todo-list li .edit").should('have.value', "Original text");
    cy.get(".todo-list li .edit").clear().type("Modified text");
    cy.get(".todo-list li .edit").type("{esc}");
    cy.contains(".todo-list li label", /^Original text$/).should("be.visible");
  });
});
