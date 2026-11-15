import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import worker from './worker.mjs';

export function createLocalServer({ handler = worker.fetch, env = process.env } = {}) {
  const server = http.createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    const disconnected = () => {
      if (!outgoing.writableFinished) abort.abort(new Error('Client disconnected'));
    };
    incoming.once('aborted', disconnected);
    outgoing.once('close', disconnected);
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const init = { method: incoming.method, headers, signal: abort.signal };
      if (!['GET', 'HEAD'].includes(incoming.method)) {
        init.body = Readable.toWeb(incoming);
        init.duplex = 'half';
      } else incoming.resume();
      const request = new Request(new URL(incoming.url, 'http://127.0.0.1'), init);
      const response = await handler(request, env);
      if (outgoing.destroyed) { await response.body?.cancel(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body && incoming.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), outgoing);
      else { await response.body?.cancel(); outgoing.end(); }
    } catch (error) {
      abort.abort(error);
      if (outgoing.headersSent) outgoing.destroy(error);
      else if (!outgoing.destroyed) {
        outgoing.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        outgoing.end('Request failed\n');
      }
    } finally {
      incoming.removeListener('aborted', disconnected);
      outgoing.removeListener('close', disconnected);
    }
  });
  server.on('connect', (_request, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  const server = createLocalServer();
  server.listen(port, '127.0.0.1', () => console.log(`Download relay: http://127.0.0.1:${port}`));
  server.on('error', (error) => { console.error(error); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}
