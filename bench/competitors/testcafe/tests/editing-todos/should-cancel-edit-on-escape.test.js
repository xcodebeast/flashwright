import { Selector } from 'testcafe';

fixture("Editing Todos")
  .page(process.env.APP_URL);

test("should-cancel-edit-on-escape", async t => {
    await t.typeText(Selector(".new-todo"), "Original text").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Original text").visible).ok();
    await t.doubleClick(Selector(".todo-list li label"));
    await t.expect(Selector(".todo-list li .edit").value).eql("Original text");
    await t.typeText(Selector(".todo-list li .edit"), "Modified text", { replace: true });
    await t.pressKey("esc");
    await t.expect(Selector(".todo-list li label").withExactText("Original text").visible).ok();
});
