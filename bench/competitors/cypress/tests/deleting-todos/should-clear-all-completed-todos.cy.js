beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Deleting Todos", () => {
  it("should-clear-all-completed-todos", () => {
    cy.get(".new-todo").type("Task 1{enter}");
    cy.get(".new-todo").type("Task 2{enter}");
    cy.get(".new-todo").type("Task 3{enter}");
    cy.get(".todo-list li label").should($titles => {
      expect([...$titles].map(title => title.textContent)).to.deep.equal(["Task 1","Task 2","Task 3"]);
    });
    cy.contains(".todo-list li", /^Task 1$/).find('.toggle').click();
    cy.contains(".todo-list li", /^Task 3$/).find('.toggle').click();
    cy.get(".todo-count").should('have.text', "1 item left");
    cy.get(".clear-completed").should("be.visible");
    cy.get(".clear-completed").click();
    cy.contains(".todo-list li label", /^Task 2$/).should("be.visible");
    cy.get(".todo-count").should('have.text', "1 item left");
  });
});
