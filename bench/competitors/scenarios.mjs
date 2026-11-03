// Playwright's TodoMVC example suite (bench/apps/todomvc/tests), as framework-neutral steps.
// Every test keeps its original file, title and order of actions and assertions; each
// framework's port is generated from these steps by its emitter (see generate.mjs), so all
// frameworks run the same tests. `page` actions go to whatever has focus, like page.keyboard.
//
// Actions:     ['add', text]                      type text into the new-todo field and press Enter
//              ['fill', field, text]              field: 'new' | 'edit'
//              ['press', field, key]              key: 'Enter' | 'Escape'
//              ['click', target]                  see targets below
//              ['dblclick', 'title']              the only todo's title
//              ['hover', item]                    item: 'item' (the only todo) | 'item:<text>'
// Assertions:  ['visible' | 'hidden', target]
//              ['value', field, text]             the field's value
//              ['checked' | 'unchecked', toggle]  toggle: 'toggle' (the only todo's) | 'toggle:<text>'
//              ['focused', 'new']
//              ['count', n]                       number of todos in the list
//              ['items', [texts]]                 the todos' titles, in order
//              ['url', suffix]                    the URL ends with suffix
// Targets:     'new', 'edit', 'todo:<text>' (a todo titled exactly text), 'counter:<text>' (the
//              "n items left" counter reads text), 'toggle', 'toggle:<text>', 'toggleAll',
//              'clearCompleted', 'heading', 'filter:Active', 'delete' (the shown delete button),
//              'list' (the todo list), 'title' (the only todo's title)

export const scenarios = [
  { file: 'adding-todos/should-add-multiple-todos', describe: 'Adding Todos', title: 'should add multiple todos', steps: [
    ['add', 'Buy milk'],
    ['visible', 'todo:Buy milk'],
    ['visible', 'counter:1 item left'],
    ['add', 'Walk the dog'],
    ['visible', 'todo:Buy milk'],
    ['visible', 'todo:Walk the dog'],
    ['visible', 'counter:2 items left'],
    ['add', 'Finish report'],
    ['visible', 'todo:Buy milk'],
    ['visible', 'todo:Walk the dog'],
    ['visible', 'todo:Finish report'],
    ['visible', 'counter:3 items left'],
  ] },
  { file: 'adding-todos/should-add-single-todo', describe: 'Adding Todos', title: 'should add single todo', steps: [
    ['visible', 'new'],
    ['fill', 'new', 'Buy groceries'],
    ['value', 'new', 'Buy groceries'],
    ['press', 'new', 'Enter'],
    ['visible', 'todo:Buy groceries'],
    ['value', 'new', ''],
    ['visible', 'counter:1 item left'],
  ] },
  { file: 'adding-todos/should-not-add-empty-todo', describe: 'Adding Todos', title: 'should not add empty todo', steps: [
    ['click', 'new'],
    ['focused', 'new'],
    ['press', 'new', 'Enter'],
    ['hidden', 'list'],
  ] },
  { file: 'adding-todos/should-trim-whitespace-from-new-todo', describe: 'Adding Todos', title: 'should trim whitespace from new todo', steps: [
    ['add', '   Todo with spaces   '],
    ['visible', 'todo:Todo with spaces'],
    ['visible', 'counter:1 item left'],
  ] },
  { file: 'completing-todos/should-complete-multiple-todos', describe: 'Completing Todos', title: 'should complete multiple todos', steps: [
    ['add', 'Buy milk'],
    ['add', 'Walk dog'],
    ['add', 'Finish report'],
    ['visible', 'todo:Buy milk'],
    ['visible', 'todo:Walk dog'],
    ['visible', 'todo:Finish report'],
    ['visible', 'counter:3 items left'],
    ['click', 'toggle:Buy milk'],
    ['checked', 'toggle:Buy milk'],
    ['visible', 'counter:2 items left'],
    ['click', 'toggle:Finish report'],
    ['checked', 'toggle:Finish report'],
    ['visible', 'counter:1 item left'],
    ['visible', 'clearCompleted'],
  ] },
  { file: 'completing-todos/should-complete-single-todo', describe: 'Completing Todos', title: 'should-complete-single-todo', steps: [
    ['add', 'Buy groceries'],
    ['visible', 'todo:Buy groceries'],
    ['visible', 'counter:1 item left'],
    ['click', 'toggle'],
    ['checked', 'toggle'],
    ['visible', 'counter:0 items left'],
    ['visible', 'clearCompleted'],
  ] },
  { file: 'completing-todos/should-toggle-all-todos-complete', describe: 'Completing Todos', title: 'should-toggle-all-todos-complete', steps: [
    ['add', 'Task 1'],
    ['add', 'Task 2'],
    ['add', 'Task 3'],
    ['visible', 'todo:Task 1'],
    ['visible', 'todo:Task 2'],
    ['visible', 'todo:Task 3'],
    ['visible', 'counter:3 items left'],
    ['click', 'toggleAll'],
    ['visible', 'counter:0 items left'],
    ['visible', 'clearCompleted'],
  ] },
  { file: 'completing-todos/should-toggle-all-todos-incomplete', describe: 'Completing Todos', title: 'should toggle all todos incomplete', steps: [
    ['add', 'First todo'],
    ['add', 'Second todo'],
    ['add', 'Third todo'],
    ['click', 'toggleAll'],
    ['visible', 'counter:0 items left'],
    ['click', 'toggleAll'],
    ['visible', 'counter:3 items left'],
  ] },
  { file: 'completing-todos/should-uncomplete-completed-todo', describe: 'Completing Todos', title: 'should-uncomplete-completed-todo', steps: [
    ['add', 'Buy groceries'],
    ['click', 'toggle'],
    ['click', 'toggle'],
  ] },
  { file: 'deleting-todos/should-clear-all-completed-todos', describe: 'Deleting Todos', title: 'should-clear-all-completed-todos', steps: [
    ['add', 'Task 1'],
    ['add', 'Task 2'],
    ['add', 'Task 3'],
    ['items', ['Task 1', 'Task 2', 'Task 3']],
    ['click', 'toggle:Task 1'],
    ['click', 'toggle:Task 3'],
    ['visible', 'counter:1 item left'],
    ['visible', 'clearCompleted'],
    ['click', 'clearCompleted'],
    ['visible', 'todo:Task 2'],
    ['visible', 'counter:1 item left'],
  ] },
  { file: 'deleting-todos/should-delete-single-todo', describe: 'Deleting Todos', title: 'should-delete-single-todo', steps: [
    ['add', 'Task to delete'],
    ['visible', 'todo:Task to delete'],
    ['visible', 'counter:1 item left'],
    ['hover', 'item'],
    ['visible', 'delete'],
    ['click', 'delete'],
    ['hidden', 'todo:Task to delete'],
    ['hidden', 'title'],
  ] },
  { file: 'deleting-todos/should-delete-specific-todo-from-multiple', describe: 'Deleting Todos', title: 'should-delete-specific-todo-from-multiple', steps: [
    ['add', 'Task 1'],
    ['add', 'Task 2'],
    ['add', 'Task 3'],
    ['visible', 'todo:Task 1'],
    ['visible', 'todo:Task 2'],
    ['visible', 'todo:Task 3'],
    ['visible', 'counter:3 items left'],
    ['hover', 'item:Task 2'],
    ['click', 'delete'],
    ['visible', 'todo:Task 1'],
    ['visible', 'todo:Task 3'],
    ['visible', 'counter:2 items left'],
  ] },
  { file: 'editing-todos/should-cancel-edit-on-escape', describe: 'Editing Todos', title: 'should-cancel-edit-on-escape', steps: [
    ['add', 'Original text'],
    ['visible', 'todo:Original text'],
    ['dblclick', 'title'],
    ['value', 'edit', 'Original text'],
    ['fill', 'edit', 'Modified text'],
    ['press', 'edit', 'Escape'],
    ['visible', 'todo:Original text'],
  ] },
  { file: 'editing-todos/should-delete-todo-when-edited-to-empty', describe: 'Editing Todos', title: 'should delete todo when edited to empty', steps: [
    ['add', 'Temporary task'],
    ['visible', 'todo:Temporary task'],
    ['visible', 'counter:1 item left'],
    ['dblclick', 'title'],
    ['visible', 'edit'],
    ['fill', 'edit', ''],
    ['press', 'edit', 'Enter'],
    ['hidden', 'todo:Temporary task'],
    ['hidden', 'title'],
  ] },
  { file: 'editing-todos/should-edit-todo-by-double-clicking', describe: 'Editing Todos', title: 'should edit todo by double-clicking', steps: [
    ['add', 'Buy milk'],
    ['visible', 'todo:Buy milk'],
    ['dblclick', 'title'],
    ['visible', 'edit'],
    ['value', 'edit', 'Buy milk'],
    ['fill', 'edit', 'Buy organic milk'],
    ['press', 'edit', 'Enter'],
    ['visible', 'todo:Buy organic milk'],
  ] },
  { file: 'editing-todos/should-save-edit-on-blur', describe: 'Editing Todos', title: 'should-save-edit-on-blur', steps: [
    ['add', 'Call dentist'],
    ['dblclick', 'title'],
    ['fill', 'edit', 'Schedule dentist appointment'],
    ['click', 'heading'],
    ['visible', 'todo:Schedule dentist appointment'],
  ] },
  { file: 'editing-todos/should-trim-whitespace-when-editing', describe: 'Editing Todos', title: 'should trim whitespace when editing', steps: [
    ['add', 'Original task'],
    ['visible', 'todo:Original task'],
    ['dblclick', 'title'],
    ['fill', 'edit', '   Edited task   '],
    ['value', 'edit', '   Edited task   '],
    ['press', 'edit', 'Enter'],
    ['visible', 'todo:Edited task'],
  ] },
  { file: 'filtering-todos/should-filter-active-todos', describe: 'Filtering Todos', title: 'should-filter-active-todos', steps: [
    ['add', 'Active 1'],
    ['add', 'Active 2'],
    ['add', 'Will complete'],
    ['visible', 'todo:Active 1'],
    ['visible', 'todo:Active 2'],
    ['visible', 'todo:Will complete'],
    ['click', 'toggle:Will complete'],
    ['checked', 'toggle:Will complete'],
    ['visible', 'counter:2 items left'],
    ['click', 'filter:Active'],
    ['url', '#/active'],
    ['visible', 'todo:Active 1'],
    ['visible', 'todo:Active 2'],
    ['hidden', 'todo:Will complete'],
    ['visible', 'filter:Active'],
  ] },
  { file: 'seed', title: 'seed', steps: [] },
  { file: 'todo-creation/add-multiple-todos', describe: 'Todo Creation', title: 'Add multiple todos', steps: [
    ['visible', 'new'],
    ['add', 'Buy groceries'],
    ['visible', 'todo:Buy groceries'],
    ['add', 'Walk the dog'],
    ['visible', 'todo:Walk the dog'],
    ['add', 'Read a book'],
    ['visible', 'todo:Read a book'],
    ['visible', 'todo:Buy groceries'],
    ['visible', 'todo:Walk the dog'],
    ['visible', 'todo:Read a book'],
    ['visible', 'counter:3 items left'],
    ['unchecked', 'toggle:Buy groceries'],
  ] },
  { file: 'todo-creation/add-single-todo', describe: 'Todo Creation', title: 'Add a single todo', steps: [
    ['visible', 'new'],
    ['fill', 'new', 'Buy groceries'],
    ['value', 'new', 'Buy groceries'],
    ['press', 'new', 'Enter'],
    ['visible', 'todo:Buy groceries'],
    ['value', 'new', ''],
    ['visible', 'counter:1 item left'],
    ['unchecked', 'toggle'],
  ] },
  { file: 'todo-creation/add-todo-special-chars', describe: 'Todo Creation', title: 'Add todo with special characters', steps: [
    ['visible', 'new'],
    ['add', 'Buy @groceries & supplies (urgent!)'],
    ['visible', 'todo:Buy @groceries & supplies (urgent!)'],
    ['visible', 'counter:1 item left'],
  ] },
  { file: 'todo-creation/prevent-empty-todo', describe: 'Todo Creation', title: 'Prevent adding empty todo', steps: [
    ['visible', 'new'],
    ['click', 'new'],
    ['press', 'new', 'Enter'],
    ['count', 0],
    ['value', 'new', ''],
  ] },
  { file: 'todo-creation/prevent-whitespace-todo', describe: 'Todo Creation', title: 'Prevent adding whitespace-only todo', steps: [
    ['visible', 'new'],
    ['add', '   '],
    ['count', 0],
  ] },
];

// CSS selectors for the targets, shared by every port. Text targets add a text match on top.
export const selectors = {
  new: '.new-todo',
  edit: '.todo-list li .edit',
  todoTitle: '.todo-list li label',
  item: '.todo-list li',
  counter: '.todo-count',
  toggle: '.todo-list li .toggle',
  toggleAll: 'label[for="toggle-all"]',
  clearCompleted: '.clear-completed',
  heading: '.header h1',
  'filter:Active': '.filters a[href="#/active"]',
  delete: '.todo-list li .destroy',
  list: '.todo-list',
  title: '.todo-list li label',
};

export function parseTarget(target) {
  const index = target.indexOf(':');
  return index === -1 ? { kind: target } : { kind: target.slice(0, index), text: target.slice(index + 1) };
}
