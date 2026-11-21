// The provider registry (architecture.md §6): one provider instance per cloud account, built with that account's
// credentials (from secrets) and kept until the account or its credentials change. An adapter's module is only loaded
// when an account needs it. The GCP and AWS adapters (roadmap 2.8–2.10) talk HTTPS with node:crypto: no cloud SDK.
import { CloudError } from './errors.js';
import { checkProvider } from './contract.js';
import { MockCloud } from './mock/cloud.js';

export const PROVIDER_LABEL = { mock: 'mock cloud', gcp: 'Google Cloud', aws: 'AWS', local: 'local servers' };

/**
 * @param {object} o
 * @param {string[]} o.enabled     INFRA_PROVIDERS
 * @param {object} o.store         the accelerator's FsStore (the mock cloud lives in it)
 * @param {object} o.secrets
 * @param {object} o.catalog
 * @param {number} [o.mockStepMs]  how long one unit of mock cloud work takes
 * @param {() => number} [o.now]
 * @param {object} [o.clouds]      the real adapters' options: { fetch, gcp: { endpoints, pollMs }, aws: { endpoint, pollMs,
 *                                 baseCredentials } } (tests point them at fakes). AWS assumes roles with this server's
 *                                 own credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN.
 */
export function createProviders({ enabled, store, secrets, catalog, mockStepMs = 1200, now = () => Date.now(), clouds = {} }) {
  const instances = new Map();
  const mockClouds = new Map();
  /** (siteId) => provider, set by mount() when local servers are on (spec 8.9.4). */
  let localFactory = null;

  function mockCloud(account) {
    if (!mockClouds.has(account.id)) {
      mockClouds.set(account.id, new MockCloud({ store, accountId: account.id, cloud: account.cloud, stepMs: mockStepMs, now }));
    }
    return mockClouds.get(account.id);
  }

  async function build(account, credentials) {
    if (account.provider === 'local' && localFactory) return localFactory(account.region ?? account.site);
    if (account.provider === 'mock') {
      const { createMockProvider } = await import('./mock/index.js');
      return createMockProvider({ account, credentials, cloud: mockCloud(account), catalog: catalog.forCloud(account.cloud) });
    }
    const fetchImpl = clouds.fetch ?? fetch;
    if (account.provider === 'gcp') {
      const { createGcpProvider } = await import('./gcp/index.js');
      return createGcpProvider({ account, credentials, catalog: catalog.forCloud('gcp'), fetchImpl, now, ...(clouds.gcp ?? {}) });
    }
    if (account.provider === 'aws') {
      const { createAwsProvider } = await import('./aws/index.js');
      const fromEnv = async () => (process.env.AWS_ACCESS_KEY_ID ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, sessionToken: process.env.AWS_SESSION_TOKEN || null } : null);
      return createAwsProvider({ account, credentials, catalog: catalog.forCloud('aws'), fetchImpl, now, baseCredentials: fromEnv, ...(clouds.aws ?? {}) });
    }
    throw new CloudError('unavailable', `There is no ${PROVIDER_LABEL[account.provider] ?? account.provider} provider.`);
  }

  return {
    enabled,
    /** Which provider a new account on `cloud` uses: the cloud's own when enabled, else the mock. */
    defaultFor(cloud) {
      if (enabled.includes(cloud)) return cloud;
      if (enabled.includes('mock')) return 'mock';
      return null;
    },
    /** The provider for an account (cached). Throws a CloudError when this install can't serve it. */
    async forAccount(account) {
      if (!enabled.includes(account.provider) && !(account.provider === 'local' && localFactory)) {
        throw new CloudError('unavailable', `This install doesn't use the ${PROVIDER_LABEL[account.provider] ?? account.provider} provider (INFRA_PROVIDERS).`);
      }
      const key = `${account.id}|${account.provider}|${account.credentialRef ?? ''}`;
      if (!instances.has(key)) {
        const credentials = account.credentialRef ? await secrets.get(account.credentialRef) : null;
        instances.set(key, checkProvider(await build(account, credentials)));
      }
      return instances.get(key);
    },
    /** Local sites as a provider: `factory(siteId)` builds one (spec 8.9.4). */
    useLocal(factory) {
      localFactory = factory;
    },
    /** Drops an account's provider (its credentials changed, or it was removed). */
    forget(accountId) {
      for (const key of instances.keys()) if (key.startsWith(`${accountId}|`)) instances.delete(key);
      mockClouds.delete(accountId);
    },
    /** Drops every provider and mock cloud held in memory (after the seed rewrote the folder). */
    reset() {
      instances.clear();
      mockClouds.clear();
    },
    /** The mock cloud of an account, for tests and demos (failAt, outOfBand). */
    mockCloud: (account) => mockCloud(account),
  };
}
