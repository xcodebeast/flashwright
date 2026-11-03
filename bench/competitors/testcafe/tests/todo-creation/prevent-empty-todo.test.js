import { Selector } from 'testcafe';

fixture("Todo Creation")
  .page(process.env.APP_URL);

test("Prevent adding empty todo", async t => {
    await t.expect(Selector(".new-todo").visible).ok();
    await t.click(Selector(".new-todo"));
    await t.pressKey("enter");
    await t.expect(Selector(".todo-list li").count).eql(0);
    await t.expect(Selector(".new-todo").value).eql("");
});
