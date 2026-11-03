import { Selector } from 'testcafe';

fixture("Completing Todos")
  .page(process.env.APP_URL);

test("should complete multiple todos", async t => {
    await t.typeText(Selector(".new-todo"), "Buy milk").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Walk dog").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Finish report").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Buy milk").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Walk dog").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Finish report").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("3 items left");
    await t.click(Selector(".todo-list li label").withExactText("Buy milk").parent('li').find('.toggle'));
    await t.expect(Selector(".todo-list li label").withExactText("Buy milk").parent('li').find('.toggle').checked).ok();
    await t.expect(Selector(".todo-count").innerText).eql("2 items left");
    await t.click(Selector(".todo-list li label").withExactText("Finish report").parent('li').find('.toggle'));
    await t.expect(Selector(".todo-list li label").withExactText("Finish report").parent('li').find('.toggle').checked).ok();
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
    await t.expect(Selector(".clear-completed").visible).ok();
});
