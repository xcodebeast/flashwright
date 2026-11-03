import { Selector } from 'testcafe';

fixture("Deleting Todos")
  .page(process.env.APP_URL);

test("should-delete-specific-todo-from-multiple", async t => {
    await t.typeText(Selector(".new-todo"), "Task 1").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Task 2").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Task 3").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Task 1").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Task 2").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Task 3").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("3 items left");
    await t.hover(Selector(".todo-list li label").withExactText("Task 2").parent('li'));
    await t.click(Selector(".todo-list li label").withExactText("Task 2").parent('li').find('.destroy'));
    await t.expect(Selector(".todo-list li label").withExactText("Task 1").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Task 3").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("2 items left");
});
