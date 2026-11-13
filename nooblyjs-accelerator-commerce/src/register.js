/**
 * @fileoverview Registers the commerce accelerator (ecommerce, warehouse and delivery) on a launcher's Express app.
 *
 * The launcher owns the app, the shared EventEmitter and an initialised nooblyjs-core serviceRegistry. This module
 * adds the commerce screens and APIs under /applications/commerce, and session and Passport middleware for that
 * prefix only, so other accelerators on the same app are not affected.
 *
 * @example
 * const { register } = require('nooblyjs-accelerator-commerce/src/register');
 * const hosted = register(app, serviceRegistry, { eventEmitter });
 *
 * @module register
 */

'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { loadConfig } = require('./config');
const { configurePassport } = require('./auth/passport-config');
const authRoutes = require('./auth/routes');
const ecommerce = require('./ecommerce/index');
const warehouse = require('./warehouse/index');
const delivery = require('./delivery/index');

/** The URL prefix for the whole accelerator. Module routes are written against it, so it is not configurable. */
const MOUNT = '/applications/commerce';

const MODULES = [
  { name: 'ecommerce', title: 'Online shop', register: ecommerce },
  { name: 'warehouse', title: 'Warehouse', register: warehouse },
  { name: 'delivery', title: 'Delivery', register: delivery },
];

/**
 * Adds the commerce accelerator to a launcher's app.
 *
 * @param {import('express').Express} app - the launcher's Express app
 * @param {Object} serviceRegistry - nooblyjs-core registry, already initialised by the launcher
 * @param {Object} options
 * @param {import('events').EventEmitter} options.eventEmitter - the launcher's shared emitter
 * @param {Object} [options.config] - configuration from loadConfig(); read from the environment when omitted
 * @return {{name: string, mountPath: string, modules: Array<{name: string, title: string, path: string}>}}
 * @throws {Error} when the configuration is invalid (for example, a missing production secret)
 */
function register(app, serviceRegistry, { eventEmitter, config = loadConfig() } = {}) {
  if (typeof app?.use !== 'function') throw new Error('commerce register needs the launcher\'s Express app');
  if (!serviceRegistry) throw new Error('commerce register needs an initialised serviceRegistry');
  config.warnings.forEach((warning) => console.warn(`[config] ${warning}`));

  // Session and Passport for the sign-in routes only.
  app.use(MOUNT, session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: config.production },
  }));
  configurePassport(passport);
  app.use(MOUNT, passport.initialize());
  app.use(MOUNT, passport.session());
  app.use(`${MOUNT}/api/auth`, authRoutes);

  for (const mod of MODULES) {
    mod.register({ express: app }, eventEmitter, serviceRegistry);
  }

  // The accelerator's own page: a list of its modules.
  app.get(MOUNT, (req, res) => {
    const items = MODULES.map((m) => `<li><a href="${MOUNT}/${m.name}/">${m.title}</a></li>`).join('');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Commerce</title><link rel="stylesheet" href="${MOUNT}/styles.css"><main><h1>Commerce</h1><ul>${items}</ul></main>`);
  });

  // Shared stylesheet for the module screens.
  app.use(MOUNT, express.static(path.join(__dirname, '..', 'public')));

  return {
    name: 'commerce',
    mountPath: MOUNT,
    modules: MODULES.map((m) => ({ name: m.name, title: m.title, path: `${MOUNT}/${m.name}` })),
  };
}

module.exports = { register, MOUNT };
