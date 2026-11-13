/**
 * @fileoverview Full-text search for the commerce modules.
 *
 * The modules call `index(container, key, document)` / `add(container, key, document)` and
 * `search(container, query)`. The core's searching service takes `add(key, document, container)` and
 * `search(query, container)`. This adapter gives the modules their argument order, and stores the id on
 * each indexed document so search hits can be matched back to records.
 *
 * @module shared/searchAccess
 */

'use strict';

/**
 * @param {Object} serviceRegistry - nooblyjs-core registry, already initialised
 * @param {{namespace?: string}} [options] - the module's name, so its index is separate from other modules'
 * @return {{index: Function, add: Function, remove: Function, search: Function}}
 */
function createSearchAccess(serviceRegistry, options = {}) {
  // A distinct instanceName per module: the core shares one searching instance per name and type otherwise.
  const core = serviceRegistry.searching('memory', { instanceName: options.namespace || 'default' });

  const put = async (container, key, document) => {
    const id = String(key);
    return core.add(id, { ...document, id }, container);
  };

  return {
    index: put,
    add: put,
    async remove(container, key) {
      return core.remove(String(key), container);
    },
    async search(container, query) {
      const hits = await core.search(query, container);
      return Array.isArray(hits) ? hits : [];
    },
  };
}

module.exports = { createSearchAccess };
