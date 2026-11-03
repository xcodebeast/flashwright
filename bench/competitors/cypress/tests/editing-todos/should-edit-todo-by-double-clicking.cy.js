beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Editing Todos", () => {
  it("should edit todo by double-clicking", () => {
    cy.get(".new-todo").type("Buy milk{enter}");
    cy.contains(".todo-list li label", /^Buy milk$/).should("be.visible");
    cy.get(".todo-list li label").dblclick();
    cy.get(".todo-list li .edit").should("be.visible");
    cy.get(".todo-list li .edit").should('have.value', "Buy milk");
    cy.get(".todo-list li .edit").clear().type("Buy organic milk");
    cy.get(".todo-list li .edit").type("{enter}");
    cy.contains(".todo-list li label", /^Buy organic milk$/).should("be.visible");
  });
});
