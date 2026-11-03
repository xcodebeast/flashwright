beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Editing Todos", () => {
  it("should delete todo when edited to empty", () => {
    cy.get(".new-todo").type("Temporary task{enter}");
    cy.contains(".todo-list li label", /^Temporary task$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "1 item left");
    cy.get(".todo-list li label").dblclick();
    cy.get(".todo-list li .edit").should("be.visible");
    cy.get(".todo-list li .edit").clear();
    cy.get(".todo-list li .edit").type("{enter}");
    cy.contains(".todo-list li label", /^Temporary task$/).should('not.exist');
    cy.get(".todo-list li label").should('not.exist');
  });
});
