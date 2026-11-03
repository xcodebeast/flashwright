beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Completing Todos", () => {
  it("should toggle all todos incomplete", () => {
    cy.get(".new-todo").type("First todo{enter}");
    cy.get(".new-todo").type("Second todo{enter}");
    cy.get(".new-todo").type("Third todo{enter}");
    cy.get("label[for=\"toggle-all\"]").click();
    cy.get(".todo-count").should('have.text', "0 items left");
    cy.get("label[for=\"toggle-all\"]").click();
    cy.get(".todo-count").should('have.text', "3 items left");
  });
});
