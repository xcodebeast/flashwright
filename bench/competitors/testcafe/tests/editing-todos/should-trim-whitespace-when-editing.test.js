import { Selector } from 'testcafe';

fixture("Editing Todos")
  .page(process.env.APP_URL);

test("should trim whitespace when editing", async t => {
    await t.typeText(Selector(".new-todo"), "Original task").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Original task").visible).ok();
    await t.doubleClick(Selector(".todo-list li label"));
    await t.typeText(Selector(".todo-list li .edit"), "   Edited task   ", { replace: true });
    await t.expect(Selector(".todo-list li .edit").value).eql("   Edited task   ");
    await t.pressKey("enter");
    await t.expect(Selector(".todo-list li label").withExactText("Edited task").visible).ok();
});
