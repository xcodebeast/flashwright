import { Selector } from 'testcafe';

fixture("Adding Todos")
  .page(process.env.APP_URL);

test("should not add empty todo", async t => {
    await t.click(Selector(".new-todo"));
    await t.expect(Selector(".new-todo").focused).ok();
    await t.pressKey("enter");
    await t.expect(Selector(".todo-list").exists).notOk();
});
