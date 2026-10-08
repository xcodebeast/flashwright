import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';

/** Execute in the application realm using native timers and a real HTTP request. */
function installApplicationWorkload(settings) {
  window.beginLoad = () => {
    if (window.observations) throw new Error('Workload already started');
    const observations = window.observations = {
      startedAt: performance.now(), tasks: 0, mutations: 0, taskIntervalsMilliseconds: [],
      lastTaskAt: 0, backendAt: 0, readyAt: 0, error: null,
    };
    let previous = observations.startedAt;
    const tasks = new Promise(resolve => {
      function tick() {
        const now = performance.now();
        observations.taskIntervalsMilliseconds.push(now - previous);
        previous = now;
        observations.tasks++;
        for (let index = 0; index < settings.mutationsPerTask; index++) {
          document.querySelector('#noise').setAttribute('data-sequence', String(++observations.mutations));
        }
        if (observations.tasks < settings.applicationTasks) window.setTimeout(tick, settings.taskIntervalMilliseconds);
        else { observations.lastTaskAt = performance.now(); resolve(); }
      }
      window.setTimeout(tick, settings.taskIntervalMilliseconds);
    });
    const backend = fetch('/ready').then(response => response.text()).then(value => {
      if (value !== 'after') throw new Error('Unexpected backend result');
      observations.backendAt = performance.now();
    });
    Promise.all([tasks, backend]).then(() => {
      const targets = [...document.querySelectorAll('.probe')].slice(-settings.conditionCount);
      for (const target of targets) {
        if (settings.workload === 'property-only') target.value = 'after';
        else target.textContent = 'after';
      }
      observations.readyAt = performance.now();
    }).catch(error => { observations.error = String(error.stack || error); });
  };
}

/** Fixed work prevents a busy renderer from appearing cheaper by dropping app ticks. */
export async function startResidentLoadFixture(configuration, scenario) {
  const property = scenario.workload === 'property-only';
  const element = property ? '<input class="probe" value="before">' : '<p class="probe">before</p>';
  const settings = JSON.stringify({ ...scenario, applicationTasks: configuration.applicationTasks,
    taskIntervalMilliseconds: configuration.taskIntervalMilliseconds, mutationsPerTask: scenario.workload === 'mutation-text' ? configuration.mutationsPerTask : 0 });
  const document = `<!doctype html><meta charset="utf-8"><title>Resident load fixture</title><link rel="icon" href="data:,"><div id="noise"></div>${element.repeat(configuration.elementCount)}<script>(${installApplicationWorkload})(${settings});</script>`;
  const counts = { documents: 0, backendRequests: 0, otherRequests: 0 };
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/fixture') {
        counts.documents++;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(document);
      } else if (request.url === '/ready') {
        counts.backendRequests++;
        await setTimeout(configuration.backendDelayMilliseconds);
        response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        response.end('after');
      } else { counts.otherRequests++; response.writeHead(404); response.end(); }
    } catch (error) { response.destroy(error); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, counts,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
