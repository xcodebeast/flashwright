import { Selector } from 'testcafe';

fixture("Editing Todos")
  .page(process.env.APP_URL);

test("should-save-edit-on-blur", async t => {
    await t.typeText(Selector(".new-todo"), "Call dentist").pressKey('enter');
    await t.doubleClick(Selector(".todo-list li label"));
    await t.typeText(Selector(".todo-list li .edit"), "Schedule dentist appointment", { replace: true });
    await t.click(Selector(".header h1"));
    await t.expect(Selector(".todo-list li label").withExactText("Schedule dentist appointment").visible).ok();
});
