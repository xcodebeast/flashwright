import { Selector } from 'testcafe';

fixture("Adding Todos")
  .page(process.env.APP_URL);

test("should add multiple todos", async t => {
    await t.typeText(Selector(".new-todo"), "Buy milk").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Buy milk").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
    await t.typeText(Selector(".new-todo"), "Walk the dog").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Buy milk").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Walk the dog").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("2 items left");
    await t.typeText(Selector(".new-todo"), "Finish report").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Buy milk").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Walk the dog").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Finish report").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("3 items left");
});
