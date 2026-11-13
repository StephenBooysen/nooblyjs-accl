/**
 * @fileoverview eCommerce routes manager. Builds the shared context and registers each section of the API.
 *
 * Sections, in registration order: status, products, cart, users, orders, payments, content, admin products,
 * admin orders, admin analytics, inventory.
 *
 * @author NooblyJS Core Team
 * @version 1.0.0
 */

'use strict';

const { createContext } = require('./context');

/**
 * Configures and registers eCommerce routes with the Express application.
 *
 * @param {Object} options - Configuration options object
 * @param {Object} options.express - The Express application instance
 * @param {Object} eventEmitter - Event emitter for logging and notifications
 * @param {Object} services - NooblyJS Core services
 * @return {void}
 */
module.exports = (options, eventEmitter, services) => {
  const ctx = createContext(options, eventEmitter, services);
  const { app, app_path, logger } = ctx;

  // ===== PUBLIC API ENDPOINTS =====

  // System status
  app.get(`/applications/commerce/${app_path}/api/status`, (req, res) => {
    res.json({
      status: 'running',
      application: 'eCommerce Platform',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    });
  });

  require('./products')(ctx);
  require('./cart')(ctx);
  require('./users')(ctx);
  require('./orders')(ctx);
  require('./payments')(ctx);
  require('./content')(ctx);
  require('./admin-products')(ctx);
  require('./admin-orders')(ctx);
  require('./admin-analytics')(ctx);
  require('./inventory')(ctx);

  logger.info(`eCommerce API routes registered successfully for /${app_path}`);
};
