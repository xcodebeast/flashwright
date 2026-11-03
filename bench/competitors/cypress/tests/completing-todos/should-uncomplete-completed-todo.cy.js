beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Completing Todos", () => {
  it("should-uncomplete-completed-todo", () => {
    cy.get(".new-todo").type("Buy groceries{enter}");
    cy.get(".todo-list li .toggle").click();
    cy.get(".todo-list li .toggle").click();
  });
});
