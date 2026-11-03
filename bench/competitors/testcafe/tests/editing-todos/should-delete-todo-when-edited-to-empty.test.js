import { Selector } from 'testcafe';

fixture("Editing Todos")
  .page(process.env.APP_URL);

test("should delete todo when edited to empty", async t => {
    await t.typeText(Selector(".new-todo"), "Temporary task").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Temporary task").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
    await t.doubleClick(Selector(".todo-list li label"));
    await t.expect(Selector(".todo-list li .edit").visible).ok();
    await t.selectText(Selector(".todo-list li .edit")).pressKey('delete');
    await t.pressKey("enter");
    await t.expect(Selector(".todo-list li label").withExactText("Temporary task").exists).notOk();
    await t.expect(Selector(".todo-list li label").exists).notOk();
});
