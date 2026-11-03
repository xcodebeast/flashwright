import { Selector } from 'testcafe';

fixture("Todo Creation")
  .page(process.env.APP_URL);

test("Prevent adding whitespace-only todo", async t => {
    await t.expect(Selector(".new-todo").visible).ok();
    await t.typeText(Selector(".new-todo"), "   ").pressKey('enter');
    await t.expect(Selector(".todo-list li").count).eql(0);
});
