/**
 * @fileoverview Data access for the commerce modules.
 *
 * The commerce modules were written against method names (`list`, `read`, `create`, `update`,
 * `jsonFindById`, `jsonFindAll`) that neither nooblyjs-core 1.0.0 nor the local core provides, so those calls
 * threw at run time. This module wraps the core's dataService and gives the modules the names they use, with
 * the behaviour they expect:
 *
 *  - every stored record carries its own `id` (the core keys records by a generated id but does not store it);
 *  - `update` merges the patch into the stored record (the core's `update` replaces the whole record);
 *  - the provider is chosen by `DATA_PROVIDER` (`memory` by default, or `file`), so data can survive a restart.
 *
 * @module shared/dataAccess
 */

'use strict';

const path = require('path');

/**
 * Creates the data access object for one module.
 *
 * @param {Object} serviceRegistry - nooblyjs-core registry, already initialised
 * @param {Object} [options]
 * @param {string} [options.provider] - 'memory' or 'file'; defaults to DATA_PROVIDER, then 'memory'
 * @param {string} [options.dataDir] - directory for the file provider; defaults to DATA_DIR, then ./data/store
 * @param {string} [options.namespace] - sub-folder for this module's containers (for the file provider)
 * @return {Object} data access object
 */
function createDataAccess(serviceRegistry, options = {}) {
  const provider = options.provider || process.env.DATA_PROVIDER || 'memory';
  // Each module gets its own folder, so two modules that both keep a 'products' container do not share a file.
  const base = options.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data', 'store');
  const providerOptions = provider === 'file'
    ? { baseDir: options.namespace ? path.join(base, options.namespace) : base }
    : {};
  // The core caches service instances by name, type and instanceName, and ignores options after the first call.
  // A distinct instanceName per module gives each module its own store (otherwise they all share one).
  const core = serviceRegistry.dataService(provider, {
    instanceName: options.namespace || 'default',
    ...providerOptions,
  });

  const getById = async (container, id) => {
    if (!id) return null;
    return core.getByUuid(container, String(id));
  };

  const access = {
    provider,

    /** Stores a record and returns its id. The stored record carries `id`. */
    async add(container, record) {
      const key = await core.add(container, { ...record });
      await core.update(container, key, { ...record, id: key });
      return key;
    },

    /** Same as add: the name the modules use for creating a record. */
    async create(container, record) {
      return access.add(container, record);
    },

    /** Merges `patch` into the stored record. Returns the updated record, or null if it does not exist. */
    async update(container, id, patch) {
      const current = await getById(container, id);
      if (!current) return null;
      const next = { ...current, ...patch, id: current.id || String(id) };
      await core.update(container, String(id), next);
      return next;
    },

    async remove(container, id) {
      return core.remove(container, String(id));
    },

    /** Returns one record by id, or null. */
    getByUuid: getById,
    read: getById,
    jsonFindById: getById,

    /** Returns every record in a container. */
    async list(container) {
      return core.listAll(container);
    },
    listAll: (container) => core.listAll(container),
    jsonFindAll: (container) => core.listAll(container),

    find: (container, term = '') => core.find(container, term),
    count: (container) => core.count(container),
    jsonFind: (container, predicate) => core.jsonFind(container, predicate),
    jsonFindByPath: (container, field, value) => core.jsonFindByPath(container, field, value),
    jsonFindByCriteria: (container, criteria) => core.jsonFindByCriteria(container, criteria),
    createContainer: (container) => core.createContainer(container),
  };

  return access;
}

module.exports = { createDataAccess };
