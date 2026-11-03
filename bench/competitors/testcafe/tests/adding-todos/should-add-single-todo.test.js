import { Selector } from 'testcafe';

fixture("Adding Todos")
  .page(process.env.APP_URL);

test("should add single todo", async t => {
    await t.expect(Selector(".new-todo").visible).ok();
    await t.typeText(Selector(".new-todo"), "Buy groceries", { replace: true });
    await t.expect(Selector(".new-todo").value).eql("Buy groceries");
    await t.pressKey("enter");
    await t.expect(Selector(".todo-list li label").withExactText("Buy groceries").visible).ok();
    await t.expect(Selector(".new-todo").value).eql("");
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
});
