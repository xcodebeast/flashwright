import { Selector } from 'testcafe';

fixture("Completing Todos")
  .page(process.env.APP_URL);

test("should-complete-single-todo", async t => {
    await t.typeText(Selector(".new-todo"), "Buy groceries").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Buy groceries").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
    await t.click(Selector(".todo-list li .toggle"));
    await t.expect(Selector(".todo-list li .toggle").checked).ok();
    await t.expect(Selector(".todo-count").innerText).eql("0 items left");
    await t.expect(Selector(".clear-completed").visible).ok();
});
