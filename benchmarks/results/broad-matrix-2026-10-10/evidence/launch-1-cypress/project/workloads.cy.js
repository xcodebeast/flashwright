const configuration = require('./admission-configuration.json');

// Each case is an ordinary isolated Cypress test. Failure cases fail through the runner.
describe('Cypress runner outcome admission', () => {
  let isolation;
  let operationStarted;
  before(() => cy.task('admissionBrowserProcesses').should('equal', 1));
  beforeEach(() => {
    operationStarted = undefined;
    cy.visit('/fixture');
    cy.window().then(window => {
      isolation = { localStorage: window.localStorage.getItem('admission'), sessionStorage: window.sessionStorage.getItem('admission'), cookies: window.document.cookie };
      expect(isolation).to.deep.equal({ localStorage: null, sessionStorage: null, cookies: '' });
      window.localStorage.setItem('admission', 'previous-test');
      window.sessionStorage.setItem('admission', 'previous-test');
      window.document.cookie = 'admission=previous-test';
    });
  });
  afterEach(function () {
    const title = this.currentTest.title;
    let milliseconds;
    cy.then(() => { milliseconds = operationStarted === undefined ? null : performance.now() - operationStarted; });
    cy.window().then(window => cy.task('admissionObservation', {
      title, milliseconds, isolation,
      trustedClicks: window.observations.clicks.filter(Boolean).length,
      untrustedClicks: window.observations.clicks.filter(trusted => !trusted).length,
      trustedChanges: window.observations.changes.filter(Boolean).length,
      untrustedChanges: window.observations.changes.filter(trusted => !trusted).length,
      applicationCount: window.observations.count,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      focused: window.document.hasFocus(), visibilityState: window.document.visibilityState,
    }));
  });
  for (const workload of configuration.workloads) {
    for (const [phase, count] of [['warmup', configuration.warmupIterations], ['sample', configuration.measuredIterations]]) {
      for (let iteration = 0; iteration < count; iteration++) {
        it(`${workload}/${phase}/${iteration}`, () => {
          cy.then(() => { operationStarted = performance.now(); });
          if (workload === 'noop') cy.window().then(window => expect(window.eval('42')).to.equal(42));
          else if (workload === 'interaction') {
            cy.contains('button', 'Increment').click();
            cy.get('#count').should('have.text', '1');
          } else if (workload === 'assertion') {
            cy.window().then(window => window.delayStatus(configuration.delayedAssertionMilliseconds));
            cy.get('[role="status"]').should('have.text', 'Ready');
          } else if (workload === 'navigation') {
            cy.intercept('GET', '**/fixture?navigation=*').as('navigation');
            cy.visit(`/fixture?navigation=${phase}-${iteration}`);
            cy.wait('@navigation').its('response.statusCode').should('equal', 200);
            cy.title().should('equal', 'Flashwright baseline');
            cy.get('[role="status"]').should('have.text', 'Ready');
          } else if (workload === 'setup') cy.get('[role="status"]').should('have.text', 'Ready');
          else if (workload === 'backend') {
            const name = `person-${iteration + (phase === 'sample' ? configuration.warmupIterations : 0) + 1}`;
            cy.intercept('POST', '/api/profile').as('profile');
            cy.get('#name').type(name);
            cy.contains('button', 'Save').click();
            cy.wait('@profile').its('response.statusCode').should('equal', 200);
            cy.get('[role="status"]').should('have.text', `Saved ${name}`);
          } else if (workload === 'failure') cy.get('#missing', { timeout: configuration.expectedFailureTimeoutMilliseconds }).should('be.visible');
          else throw new Error(`Unknown workload: ${workload}`);
        });
      }
    }
  }
});
