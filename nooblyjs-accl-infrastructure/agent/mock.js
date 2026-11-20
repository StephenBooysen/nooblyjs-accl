// The in-process mock agent (spec 8.9.1): the real agent session (core.js) on the in-memory Docker (docker-mock.js),
// joined to the controller by an in-memory link. Tests and the offline seed story use it in place of a server.
import { createLink } from './link.js';
import { createMockDocker } from './docker-mock.js';
import { startSession } from './core.js';

/**
 * @param {object} o
 * @param {{ server?: string, credential?: string, token?: string }} o.identity
 * @param {boolean} [o.dev]
 * @param {object} [o.facts]          overrides the mock server's facts
 * @param {(w: object) => void} [o.onWelcome]
 * @returns {{ transport: object, docker: ReturnType<typeof createMockDocker>, session: ReturnType<typeof startSession>, welcome: Promise<object>, refused: Promise<{ reason: string, retry: boolean, type: string }> }}
 *   `transport` is the controller's end of the link
 */
export function startMockAgent({ identity, dev = true, facts, onWelcome } = {}) {
  const link = createLink();
  const docker = createMockDocker({ facts });
  let welcomed;
  const welcome = new Promise((resolve) => { welcomed = resolve; });
  let refusedWith;
  const refused = new Promise((resolve) => { refusedWith = resolve; });
  const session = startSession({
    transport: link.agent,
    docker,
    identity,
    dev,
    facts: () => docker.facts(),
    onWelcome: async (w) => {
      await onWelcome?.(w);
      welcomed(w);
    },
    onRefused: (reason, o) => refusedWith({ reason, ...o }),
  });
  return { transport: link.controller, docker, session, welcome, refused };
}
