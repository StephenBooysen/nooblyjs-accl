// WebSocket upgrades for accelerators (spec 8.9 "Controller"). An accelerator never listens on a port, so a launcher
// that wants to offer `host.onUpgrade(path, handler)` keeps one of these and passes its HTTP server's `upgrade` events
// through with attach(server). Paths match exactly; anything else is answered 404 and closed.

/** @returns {{ onUpgrade(path: string, handler: (req, socket, head) => void): () => void, attach(server): () => void, paths(): string[] }} */
export function createUpgradeRouter() {
  const handlers = new Map();
  return {
    onUpgrade(path, handler) {
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('onUpgrade needs a path that starts with /.');
      if (typeof handler !== 'function') throw new Error('onUpgrade needs a handler(req, socket, head).');
      if (handlers.has(path)) throw new Error(`Something already answers upgrades at ${path}.`);
      handlers.set(path, handler);
      return () => { if (handlers.get(path) === handler) handlers.delete(path); };
    },
    attach(server) {
      const listener = (req, socket, head) => {
        let pathname = '/';
        try {
          pathname = new URL(req.url, 'http://x').pathname;
        } catch { /* bad URL: 404 below */ }
        const handler = handlers.get(pathname);
        if (!handler) {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        try {
          handler(req, socket, head);
        } catch {
          socket.destroy();
        }
      };
      server.on('upgrade', listener);
      return () => server.off('upgrade', listener);
    },
    paths: () => [...handlers.keys()],
  };
}
