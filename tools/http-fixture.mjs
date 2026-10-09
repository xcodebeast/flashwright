import { createServer } from 'node:http';

/** Own fixture connections so teardown also terminates unfinished HTTP responses. */
export function createHttpFixture(listener) {
  return ownFixtureServer(createServer(listener));
}

/** HTTP and HTTPS fixtures share connection ownership, including incomplete requests. */
export function ownFixtureServer(server) {
  const connections = new Set();
  server.on('connection', connection => {
    connections.add(connection);
    connection.once('close', () => connections.delete(connection));
  });
  return {
    server,
    close: () => new Promise((resolve, reject) => {
      // Bun clears its internal listener on close, making closeAllConnections a no-op.
      // Track sockets from acceptance so both runtimes release active requests too.
      server.close(error => error ? reject(error) : resolve());
      for (const connection of connections) connection.destroy();
    }),
  };
}
