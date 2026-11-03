beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Deleting Todos", () => {
  it("should-delete-single-todo", () => {
    cy.get(".new-todo").type("Task to delete{enter}");
    cy.contains(".todo-list li label", /^Task to delete$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "1 item left");
    // Cypress has no hover: the delete button only shows on :hover, so it is checked to exist and clicked with { force: true }.
    cy.get(".todo-list li").find('.destroy').should("exist");
    cy.get(".todo-list li").find('.destroy').click({ force: true });
    cy.contains(".todo-list li label", /^Task to delete$/).should('not.exist');
    cy.get(".todo-list li label").should('not.exist');
  });
});
