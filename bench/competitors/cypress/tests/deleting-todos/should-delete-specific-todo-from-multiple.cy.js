beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Deleting Todos", () => {
  it("should-delete-specific-todo-from-multiple", () => {
    cy.get(".new-todo").type("Task 1{enter}");
    cy.get(".new-todo").type("Task 2{enter}");
    cy.get(".new-todo").type("Task 3{enter}");
    cy.contains(".todo-list li label", /^Task 1$/).should("be.visible");
    cy.contains(".todo-list li label", /^Task 2$/).should("be.visible");
    cy.contains(".todo-list li label", /^Task 3$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "3 items left");
    // Cypress has no hover: the delete button only shows on :hover, so it is checked to exist and clicked with { force: true }.
    cy.contains(".todo-list li", /^Task 2$/).find('.destroy').click({ force: true });
    cy.contains(".todo-list li label", /^Task 1$/).should("be.visible");
    cy.contains(".todo-list li label", /^Task 3$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "2 items left");
  });
});
