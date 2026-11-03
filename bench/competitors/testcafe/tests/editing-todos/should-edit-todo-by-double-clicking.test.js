import { Selector } from 'testcafe';

fixture("Editing Todos")
  .page(process.env.APP_URL);

test("should edit todo by double-clicking", async t => {
    await t.typeText(Selector(".new-todo"), "Buy milk").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Buy milk").visible).ok();
    await t.doubleClick(Selector(".todo-list li label"));
    await t.expect(Selector(".todo-list li .edit").visible).ok();
    await t.expect(Selector(".todo-list li .edit").value).eql("Buy milk");
    await t.typeText(Selector(".todo-list li .edit"), "Buy organic milk", { replace: true });
    await t.pressKey("enter");
    await t.expect(Selector(".todo-list li label").withExactText("Buy organic milk").visible).ok();
});
