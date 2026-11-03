beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Adding Todos", () => {
  it("should trim whitespace from new todo", () => {
    cy.get(".new-todo").type("   Todo with spaces   {enter}");
    cy.contains(".todo-list li label", /^Todo with spaces$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "1 item left");
  });
});
