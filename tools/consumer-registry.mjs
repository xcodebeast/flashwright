import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** Serve immutable local packages through normal npm metadata and integrity fields. */
export async function startConsumerRegistry(archives) {
  const packages = new Map();
  for (const archive of archives) {
    const bytes = await readFile(archive);
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    packages.set(manifest.name, { bytes, manifest });
  }
  const requests = [];
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname.slice(1));
    requests.push({ method: request.method, path: pathname });
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
    if (pathname.startsWith('artifacts/')) {
      const entry = packages.get(pathname.slice('artifacts/'.length));
      if (entry) { response.setHeader('content-type', 'application/octet-stream'); response.end(entry.bytes); return; }
    }
    const entry = packages.get(pathname);
    if (entry) {
      const version = { ...entry.manifest, dist: {
        tarball: `http://127.0.0.1:${server.address().port}/artifacts/${encodeURIComponent(pathname)}`,
        integrity: 'sha512-' + createHash('sha512').update(entry.bytes).digest('base64'),
        shasum: createHash('sha1').update(entry.bytes).digest('hex'),
      } };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name: pathname, 'dist-tags': { latest: version.version }, versions: { [version.version]: version } }));
    } else if (pathname.startsWith('@flashwright/') || pathname === 'flashwright') {
      response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":"not found"}');
    } else {
      response.writeHead(302, { location: 'https://registry.npmjs.org/' + request.url.slice(1) }); response.end();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/`, requests,
    packageDescriptors: [...packages.values()].map(({ manifest }) => `${manifest.name}@${manifest.version}`),
    close: () => new Promise(resolve => server.close(resolve)) };
}
