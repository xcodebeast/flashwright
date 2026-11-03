beforeEach(() => {
  cy.visit(Cypress.expose('APP_URL'));
});

describe("Editing Todos", () => {
  it("should-save-edit-on-blur", () => {
    cy.get(".new-todo").type("Call dentist{enter}");
    cy.get(".todo-list li label").dblclick();
    cy.get(".todo-list li .edit").clear().type("Schedule dentist appointment");
    cy.get(".header h1").click();
    cy.contains(".todo-list li label", /^Schedule dentist appointment$/).should("be.visible");
  });
});
