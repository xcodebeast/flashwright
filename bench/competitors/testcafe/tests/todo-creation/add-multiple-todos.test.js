import { Selector } from 'testcafe';

fixture("Todo Creation")
  .page(process.env.APP_URL);

test("Add multiple todos", async t => {
    await t.expect(Selector(".new-todo").visible).ok();
    await t.typeText(Selector(".new-todo"), "Buy groceries").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Buy groceries").visible).ok();
    await t.typeText(Selector(".new-todo"), "Walk the dog").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Walk the dog").visible).ok();
    await t.typeText(Selector(".new-todo"), "Read a book").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Read a book").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Buy groceries").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Walk the dog").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Read a book").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("3 items left");
    await t.expect(Selector(".todo-list li label").withExactText("Buy groceries").parent('li').find('.toggle').checked).notOk();
});
