beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Adding Todos", () => {
  it("should not add empty todo", () => {
    cy.get(".new-todo").click();
    cy.get(".new-todo").should('have.focus');
    cy.get(".new-todo").type("{enter}");
    cy.get(".todo-list").should('not.exist');
  });
});
