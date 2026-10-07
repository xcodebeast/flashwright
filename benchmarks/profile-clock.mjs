import { createServer } from 'node:net';
import { once } from 'node:events';

/** Bracket the sample's monotonic clock without inserting commands into Chromium. */
export async function startProfileClock() {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let pending = '';
    socket.on('data', chunk => {
      pending += chunk.toString('ascii');
      while (pending.includes('\n')) {
        const boundary = pending.indexOf('\n');
        const request = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (request !== 'clock') { socket.destroy(); return; }
        socket.write(process.hrtime.bigint().toString() + '\n');
      }
      if (pending.length > 64) socket.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT = String(server.address().port);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    delete process.env.FLASHWRIGHT_PROFILE_CLOCK_PORT;
  };
}
