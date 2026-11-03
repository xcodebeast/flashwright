beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Completing Todos", () => {
  it("should-complete-single-todo", () => {
    cy.get(".new-todo").type("Buy groceries{enter}");
    cy.contains(".todo-list li label", /^Buy groceries$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "1 item left");
    cy.get(".todo-list li .toggle").click();
    cy.get(".todo-list li .toggle").should('be.checked');
    cy.get(".todo-count").should('have.text', "0 items left");
    cy.get(".clear-completed").should("be.visible");
  });
});
