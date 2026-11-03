beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Todo Creation", () => {
  it("Prevent adding whitespace-only todo", () => {
    cy.get(".new-todo").should("be.visible");
    cy.get(".new-todo").type("   {enter}");
    cy.get(".todo-list li").should('have.length', 0);
  });
});
