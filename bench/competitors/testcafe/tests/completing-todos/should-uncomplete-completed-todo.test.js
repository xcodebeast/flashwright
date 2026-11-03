import { Selector } from 'testcafe';

fixture("Completing Todos")
  .page(process.env.APP_URL);

test("should-uncomplete-completed-todo", async t => {
    await t.typeText(Selector(".new-todo"), "Buy groceries").pressKey('enter');
    await t.click(Selector(".todo-list li .toggle"));
    await t.click(Selector(".todo-list li .toggle"));
});
