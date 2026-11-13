/**
 * @fileoverview The launcher: one Express app and one nooblyjs-core service registry, with every accelerator mounted
 * under /applications/<accelerator>.
 *
 *   /applications/infrastructure   Noobly Cloud (screens and API)
 *   /applications/commerce         Commerce hub; its modules are /applications/commerce/{ecommerce,warehouse,delivery}
 *   /applications/customer         Customers (customer, marketing and support modules are /applications/{customer,marketing,support})
 *   /applications/analytics        Analytics screen
 *
 * @author NooblyJS Core Team
 * @version 1.0.0
 * @since 2025-08-24
 */

'use strict';
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { pathToFileURL } = require('url');
const { EventEmitter } = require('events');

// Iniitiate the Web and Api Interface
const app = express();
const PORT = process.env.PORT || 3003;
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// initiate the event mechanism
const eventEmitter = new EventEmitter();
function patchEmitter(eventEmitter) {
  const originalEmit = eventEmitter.emit;
  eventEmitter.emit = function () {
    const eventName = arguments[0];
    const args = Array.from(arguments).slice(1);
    console.log(`Caught event: "${eventName}" with arguments:`, args);
    return originalEmit.apply(this, arguments);
  };
}
patchEmitter(eventEmitter);

// Initiate the service Registry: one for every accelerator
const serviceRegistry = require('nooblyjs-core');
serviceRegistry.initialize(app, eventEmitter);

const log = serviceRegistry.logger('console');

/** Mount paths, one per accelerator. Each sits under /applications/<name>. */
const MOUNT = Object.freeze({
  infrastructure: '/applications/infrastructure',
  commerce: '/applications/commerce',
  analytics: '/applications/analytics',
});

/**
 * Roles for the customer accelerator's demo sign-in. The launcher has no sign-in of its own for customers yet, so every
 * request gets the roles in CX_DEMO_ROLES (default `admin`). It refuses to run with NODE_ENV=production.
 */
function customerRoles() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The customer accelerator has no sign-in in the launcher yet; it refuses to run with NODE_ENV=production.');
  }
  return (process.env.CX_DEMO_ROLES || 'admin').split(',').map((r) => r.trim()).filter(Boolean);
}

/**
 * Loads the accelerators. Each one mounts under /applications/<name>.
 *
 * - infrastructure exports register(app, serviceRegistry, { mountPath, dataDir, host }) and uses the development host
 *   from its standalone module (it signs anyone in as anyone at /login and refuses NODE_ENV=production).
 * - commerce, analytics and customer each export a mount or register function that takes the same app and registry.
 */
async function loadAccelerators() {
  const load = (file) => import(pathToFileURL(path.join(__dirname, file)).href);
  const dataRoot = path.join(__dirname, '.application', 'data');

  // Infrastructure
  const { createDevLauncher } = await load('nooblyjs-accelerator-infrastructure/src/host/standalone.js');
  const launcher = createDevLauncher({ express, rootDir: dataRoot, log });
  launcher.mount(app);

  const infrastructure = await load('nooblyjs-accelerator-infrastructure/index.js');
  const dataDir = path.join(dataRoot, 'infrastructure');
  const hosted = await infrastructure.register(app, serviceRegistry, {
    mountPath: MOUNT.infrastructure, dataDir, host: launcher.hostFor(dataDir),
  });
  launcher.add(hosted, MOUNT.infrastructure);
  log.info(`mounted ${hosted.name} at ${MOUNT.infrastructure}`);

  // Commerce
  const { register: registerCommerce } = require('./nooblyjs-accelerator-commerce/src/register');
  const commerce = registerCommerce(app, serviceRegistry, { eventEmitter });
  log.info(`mounted ${commerce.name} at ${commerce.mountPath} (${commerce.modules.map((m) => m.name).join(', ')})`);

  // Customers: the library mounts its modules under basePath (/applications/customer, /applications/marketing, ...)
  const customers = require('./nooblyjs-accelerator-customers');
  const roles = customerRoles();
  const cx = await customers.mount(app, eventEmitter, serviceRegistry, {
    modules: ['customer', 'marketing', 'support'],
    basePath: '/applications',
    auth: { roleResolver: () => roles },
  });
  log.info(`mounted customers at /applications/{customer,marketing,support}`);

  // Analytics
  const analytics = require('./nooblyjs-accelerator-analytics');
  const hostedAnalytics = analytics.register(app, serviceRegistry, { mountPath: MOUNT.analytics });
  log.info(`mounted ${hostedAnalytics.name} at ${hostedAnalytics.mountPath}`);

  const modules = (names) => names.map((name) => ({ name, path: `/applications/${name}/` }));
  locations.push(
    { name: 'infrastructure', path: `${MOUNT.infrastructure}/` },
    { name: 'commerce', path: `${MOUNT.commerce}` },
    ...commerce.modules.map((m) => ({ name: `commerce/${m.name}`, path: `${m.path}/` })),
    ...modules(['customer', 'marketing', 'support']).map((m) => ({ name: `customers/${m.name.replace('/applications/', '')}`, path: m.path })),
    { name: 'analytics', path: hostedAnalytics.mountPath },
  );

  return { cx };
}

/** Where each accelerator is served, filled in by loadAccelerators() and printed when the launcher starts. */
const locations = [];

loadAccelerators()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NooblyJS launcher listening on http://localhost:${PORT}`);
      console.log('Accelerator locations:');
      for (const loc of locations) {
        console.log(`  ${loc.name.padEnd(24)} http://localhost:${PORT}${loc.path}`);
      }
    });
  })
  .catch((err) => {
    console.error(`Could not load the accelerators: ${err.stack}`);
    process.exit(1);
  });
