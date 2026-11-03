beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Completing Todos", () => {
  it("should complete multiple todos", () => {
    cy.get(".new-todo").type("Buy milk{enter}");
    cy.get(".new-todo").type("Walk dog{enter}");
    cy.get(".new-todo").type("Finish report{enter}");
    cy.contains(".todo-list li label", /^Buy milk$/).should("be.visible");
    cy.contains(".todo-list li label", /^Walk dog$/).should("be.visible");
    cy.contains(".todo-list li label", /^Finish report$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "3 items left");
    cy.contains(".todo-list li", /^Buy milk$/).find('.toggle').click();
    cy.contains(".todo-list li", /^Buy milk$/).find('.toggle').should('be.checked');
    cy.get(".todo-count").should('have.text', "2 items left");
    cy.contains(".todo-list li", /^Finish report$/).find('.toggle').click();
    cy.contains(".todo-list li", /^Finish report$/).find('.toggle').should('be.checked');
    cy.get(".todo-count").should('have.text', "1 item left");
    cy.get(".clear-completed").should("be.visible");
  });
});
