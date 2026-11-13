/**
 * @fileoverview Runs the commerce accelerator on its own. The launcher at the monorepo root registers it the same way
 * (see src/register.js); this file is the standalone host for development.
 *
 * @author NooblyJS Core Team
 * @version 1.0.0
 */

'use strict';
const express = require('express');
const bodyParser = require('body-parser');
const { EventEmitter } = require('events');
const serviceRegistry = require('nooblyjs-core');
const { loadConfig } = require('./src/config');
const { register } = require('./src/register');

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const eventEmitter = new EventEmitter();
serviceRegistry.initialize(app, eventEmitter);

const hosted = register(app, serviceRegistry, { eventEmitter, config });

app.listen(config.port, () => {
  console.log(`NooblyJS Commerce running on port ${config.port} at ${hosted.mountPath}`);
});
