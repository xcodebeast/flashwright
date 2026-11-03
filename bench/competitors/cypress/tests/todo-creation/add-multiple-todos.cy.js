beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Todo Creation", () => {
  it("Add multiple todos", () => {
    cy.get(".new-todo").should("be.visible");
    cy.get(".new-todo").type("Buy groceries{enter}");
    cy.contains(".todo-list li label", /^Buy groceries$/).should("be.visible");
    cy.get(".new-todo").type("Walk the dog{enter}");
    cy.contains(".todo-list li label", /^Walk the dog$/).should("be.visible");
    cy.get(".new-todo").type("Read a book{enter}");
    cy.contains(".todo-list li label", /^Read a book$/).should("be.visible");
    cy.contains(".todo-list li label", /^Buy groceries$/).should("be.visible");
    cy.contains(".todo-list li label", /^Walk the dog$/).should("be.visible");
    cy.contains(".todo-list li label", /^Read a book$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "3 items left");
    cy.contains(".todo-list li", /^Buy groceries$/).find('.toggle').should('not.be.checked');
  });
});
