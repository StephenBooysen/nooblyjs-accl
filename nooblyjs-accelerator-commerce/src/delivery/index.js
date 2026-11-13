/**
 * @fileoverview Delivery Management System (DMS)
 *
 * Comprehensive delivery management system that handles:
 * - Order management and assignment
 * - Driver management and scheduling
 * - Route optimization and navigation
 * - Real-time tracking and customer communication
 * - Analytics and performance monitoring
 *
 * @author NooblyJS Team
 * @version 1.0.0
 */

'use strict';

const { createSearchAccess } = require('../shared/searchAccess');
const { createDataAccess } = require('../shared/dataAccess');
const Routes = require('./routes');
const Views = require('./views');
const DataManager = require('./components/datamanager');

/**
 * Creates the Delivery Management System (DMS)
 * Automatically configures routes and views for comprehensive delivery operations.
 * Integrates with noobly-core services for data persistence, caching, messaging, etc.
 *
 * @param {Object} options - Configuration options
 * @param {string} options.path - Base path for the delivery app (default: 'delivery')
 * @param {EventEmitter} eventEmitter - Global event emitter for inter-service communication
 * @param {Object} serviceRegistry - NooblyJS Core service registry
 * @return {void}
 */
module.exports = (options, eventEmitter, serviceRegistry) => {
  const app_path = options.path || 'delivery';

  // Initialize core services for delivery management
  const dataManager = new DataManager('./data');
  const dataServe = createDataAccess(serviceRegistry, { namespace: 'delivery' }); // JSON document storage for orders, drivers, etc.
  const filing = serviceRegistry.filing('local', {
    baseDir: `./${app_path}-files`
  });
  const cache = serviceRegistry.cache('memory'); // High-performance caching for frequent data
  const logger = serviceRegistry.logger('console');
  const queueing = serviceRegistry.queue('memory'); // Task queue for order processing
  const scheduling = serviceRegistry.scheduling('memory'); // Task scheduling for deliveries
  const searching = createSearchAccess(serviceRegistry, { namespace: 'delivery' }); // Full-text search for orders/drivers
  const notifying = serviceRegistry.notifying('memory'); // Pub/sub for real-time updates
  const workflow = serviceRegistry.workflow('memory'); // Multi-step workflows (onboarding, delivery)
  const working = serviceRegistry.working('memory'); // Background tasks
  const measuring = serviceRegistry.measuring('memory'); // Metrics and analytics

  // Create services object for easy access
  const services = {
    dataManager,
    dataServe,
    filing,
    cache,
    logger,
    queueing,
    scheduling,
    searching,
    notifying,
    workflow,
    working,
    measuring
  };

  // Register routes and views with all services
  // The search index is in memory, so rebuild it from the stored orders at start-up (the store survives a restart
  // when DATA_PROVIDER=file).
  dataServe.list('orders')
    .then((orders) => Promise.all(orders.map((order) => searching.add('orders', order.id, order))))
    .then((orders) => logger.info(`Delivery search index rebuilt: ${orders.length} orders`))
    .catch((error) => logger.error('Failed to rebuild delivery search index:', error));

  Routes(options, eventEmitter, services);
  Views(options, eventEmitter, services);

  logger.info(`Delivery Management System (DMS) initialized on path: ${app_path}`);
  logger.info('Available services: dataServe, filing, cache, queueing, scheduling, searching, notifying, workflow, working, measuring');
}
