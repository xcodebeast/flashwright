import { Selector } from 'testcafe';

fixture("Deleting Todos")
  .page(process.env.APP_URL);

test("should-delete-single-todo", async t => {
    await t.typeText(Selector(".new-todo"), "Task to delete").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Task to delete").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
    await t.hover(Selector(".todo-list li"));
    await t.expect(Selector(".todo-list li").find('.destroy').visible).ok();
    await t.click(Selector(".todo-list li").find('.destroy'));
    await t.expect(Selector(".todo-list li label").withExactText("Task to delete").exists).notOk();
    await t.expect(Selector(".todo-list li label").exists).notOk();
});
