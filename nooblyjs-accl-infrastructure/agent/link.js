// An in-memory pair of transports with the WebSocket's shape (send, onMessage, onClose, close), for the mock agent and
// tests (spec 8.9.1). Delivery is asynchronous, like a socket, and in order; like a WebSocket's close frame, close()
// takes effect after the messages already sent have been delivered.

/** @returns {{ agent: object, controller: object }} */
export function createLink() {
  const make = () => ({ listeners: [], closers: [], open: true, closing: false });
  const a = make();
  const b = make();
  const side = (me, other) => ({
    send(text) {
      if (!me.open || me.closing) throw new Error('The link is closed.');
      const copy = String(text);
      queueMicrotask(() => { if (other.open) for (const fn of other.listeners) fn(copy); });
    },
    onMessage(fn) { me.listeners.push(fn); },
    onClose(fn) { me.closers.push(fn); },
    close() {
      if (me.closing || !me.open) return;
      me.closing = true;
      other.closing = true;
      queueMicrotask(() => {
        for (const s of [me, other]) {
          if (!s.open) continue;
          s.open = false;
          for (const fn of s.closers) fn();
        }
      });
    },
    get open() { return me.open && !me.closing; },
  });
  return { agent: side(a, b), controller: side(b, a) };
}
