import { ClientFunction, Selector } from 'testcafe';

const getLocation = ClientFunction(() => document.location.href);

fixture("Filtering Todos")
  .page(process.env.APP_URL);

test("should-filter-active-todos", async t => {
    await t.typeText(Selector(".new-todo"), "Active 1").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Active 2").pressKey('enter');
    await t.typeText(Selector(".new-todo"), "Will complete").pressKey('enter');
    await t.expect(Selector(".todo-list li label").withExactText("Active 1").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Active 2").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Will complete").visible).ok();
    await t.click(Selector(".todo-list li label").withExactText("Will complete").parent('li').find('.toggle'));
    await t.expect(Selector(".todo-list li label").withExactText("Will complete").parent('li').find('.toggle').checked).ok();
    await t.expect(Selector(".todo-count").innerText).eql("2 items left");
    await t.click(Selector(".filters a[href=\"#/active\"]"));
    await t.expect(getLocation()).match(/\#\/active$/);
    await t.expect(Selector(".todo-list li label").withExactText("Active 1").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Active 2").visible).ok();
    await t.expect(Selector(".todo-list li label").withExactText("Will complete").exists).notOk();
    await t.expect(Selector(".filters a[href=\"#/active\"]").visible).ok();
});
