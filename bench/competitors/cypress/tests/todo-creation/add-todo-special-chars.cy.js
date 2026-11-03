beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Todo Creation", () => {
  it("Add todo with special characters", () => {
    cy.get(".new-todo").should("be.visible");
    cy.get(".new-todo").type("Buy @groceries & supplies (urgent!){enter}");
    cy.contains(".todo-list li label", /^Buy @groceries & supplies \(urgent!\)$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "1 item left");
  });
});
