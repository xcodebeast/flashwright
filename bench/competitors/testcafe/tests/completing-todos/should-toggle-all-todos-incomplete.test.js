import { Selector } from 'testcafe';

fixture("Completing Todos")
  .page(process.env.APP_URL);

test("should toggle all todos incomplete", async t => {
    await t.typeText(Selector(".new-todo"), "First todo").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Second todo").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Third todo").pressKey('enter');
    await t.click(Selector("label[for=\"toggle-all\"]"));
    await t.expect(Selector(".todo-count").innerText).eql("0 items left");
    await t.click(Selector("label[for=\"toggle-all\"]"));
    await t.expect(Selector(".todo-count").innerText).eql("3 items left");
});
