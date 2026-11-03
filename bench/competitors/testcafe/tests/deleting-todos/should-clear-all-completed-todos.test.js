import { Selector } from 'testcafe';

fixture("Deleting Todos")
  .page(process.env.APP_URL);

test("should-clear-all-completed-todos", async t => {
    await t.typeText(Selector(".new-todo"), "Task 1").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Task 2").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Task 3").pressKey('enter');
    await t.expect(Selector(".todo-list li label").count).eql(3);
    await t.expect(Selector(".todo-list li label").nth(0).innerText).eql("Task 1");
    await t.expect(Selector(".todo-list li label").nth(1).innerText).eql("Task 2");
    await t.expect(Selector(".todo-list li label").nth(2).innerText).eql("Task 3");
    await t.click(Selector(".todo-list li label").withExactText("Task 1").parent('li').find('.toggle'));
    await t.click(Selector(".todo-list li label").withExactText("Task 3").parent('li').find('.toggle'));
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
    await t.expect(Selector(".clear-completed").visible).ok();
    await t.click(Selector(".clear-completed"));
    await t.expect(Selector(".todo-list li label").withExactText("Task 2").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
});
