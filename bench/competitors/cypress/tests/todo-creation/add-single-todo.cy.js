beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Todo Creation", () => {
  it("Add a single todo", () => {
    cy.get(".new-todo").should("be.visible");
    cy.get(".new-todo").clear().type("Buy groceries");
    cy.get(".new-todo").should('have.value', "Buy groceries");
    cy.get(".new-todo").type("{enter}");
    cy.contains(".todo-list li label", /^Buy groceries$/).should("be.visible");
    cy.get(".new-todo").should('have.value', "");
    cy.get(".todo-count").should('have.text', "1 item left");
    cy.get(".todo-list li .toggle").should('not.be.checked');
  });
});
