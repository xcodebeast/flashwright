beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Completing Todos", () => {
  it("should-toggle-all-todos-complete", () => {
    cy.get(".new-todo").type("Task 1{enter}");
    cy.get(".new-todo").type("Task 2{enter}");
    cy.get(".new-todo").type("Task 3{enter}");
    cy.contains(".todo-list li label", /^Task 1$/).should("be.visible");
    cy.contains(".todo-list li label", /^Task 2$/).should("be.visible");
    cy.contains(".todo-list li label", /^Task 3$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "3 items left");
    cy.get("label[for=\"toggle-all\"]").click();
    cy.get(".todo-count").should('have.text', "0 items left");
    cy.get(".clear-completed").should("be.visible");
  });
});
