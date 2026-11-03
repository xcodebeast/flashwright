import { Selector } from 'testcafe';

fixture("Adding Todos")
  .page(process.env.APP_URL);

test("should trim whitespace from new todo", async t => {
    await t.typeText(Selector(".new-todo"), "   Todo with spaces   ").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Todo with spaces").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
});
