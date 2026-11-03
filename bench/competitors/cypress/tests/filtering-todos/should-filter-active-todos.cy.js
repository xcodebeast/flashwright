beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Filtering Todos", () => {
  it("should-filter-active-todos", () => {
    cy.get(".new-todo").type("Active 1{enter}");
    cy.get(".new-todo").type("Active 2{enter}");
    cy.get(".new-todo").type("Will complete{enter}");
    cy.contains(".todo-list li label", /^Active 1$/).should("be.visible");
    cy.contains(".todo-list li label", /^Active 2$/).should("be.visible");
    cy.contains(".todo-list li label", /^Will complete$/).should("be.visible");
    cy.contains(".todo-list li", /^Will complete$/).find('.toggle').click();
    cy.contains(".todo-list li", /^Will complete$/).find('.toggle').should('be.checked');
    cy.get(".todo-count").should('have.text', "2 items left");
    cy.get(".filters a[href=\"#/active\"]").click();
    cy.url().should('match', /\#\/active$/);
    cy.contains(".todo-list li label", /^Active 1$/).should("be.visible");
    cy.contains(".todo-list li label", /^Active 2$/).should("be.visible");
    cy.contains(".todo-list li label", /^Will complete$/).should('not.exist');
    cy.get(".filters a[href=\"#/active\"]").should("be.visible");
  });
});
