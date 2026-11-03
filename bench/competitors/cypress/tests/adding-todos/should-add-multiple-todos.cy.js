beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Adding Todos", () => {
  it("should add multiple todos", () => {
    cy.get(".new-todo").type("Buy milk{enter}");
    cy.contains(".todo-list li label", /^Buy milk$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "1 item left");
    cy.get(".new-todo").type("Walk the dog{enter}");
    cy.contains(".todo-list li label", /^Buy milk$/).should("be.visible");
    cy.contains(".todo-list li label", /^Walk the dog$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "2 items left");
    cy.get(".new-todo").type("Finish report{enter}");
    cy.contains(".todo-list li label", /^Buy milk$/).should("be.visible");
    cy.contains(".todo-list li label", /^Walk the dog$/).should("be.visible");
    cy.contains(".todo-list li label", /^Finish report$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "3 items left");
  });
});
