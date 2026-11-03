import { Selector } from 'testcafe';

fixture("Todo Creation")
  .page(process.env.APP_URL);

test("Add todo with special characters", async t => {
    await t.expect(Selector(".new-todo").visible).ok();
    await t.typeText(Selector(".new-todo"), "Buy @groceries & supplies (urgent!)").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Buy @groceries & supplies (urgent!)").visible).ok();
    await t.expect(Selector(".todo-count").innerText).eql("1 item left");
});
