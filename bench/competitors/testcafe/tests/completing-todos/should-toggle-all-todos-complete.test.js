import { Selector } from 'testcafe';

fixture("Completing Todos")
  .page(process.env.APP_URL);

test("should-toggle-all-todos-complete", async t => {
    await t.typeText(Selector(".new-todo"), "Task 1").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Task 2").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Task 3").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Task 1").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Task 2").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Task 3").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("3 items left");
    await t.click(Selector("label[for=\"toggle-all\"]"));
    await t.expect(Selector(".todo-count").innerText).eql("0 items left");
    await t.expect(Selector(".clear-completed").visible).ok();
});
