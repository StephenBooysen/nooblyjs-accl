/**
 * @fileoverview Runs the analytics screen on its own, for development. The launcher registers it the same way.
 */

'use strict';
const express = require('express');
const { EventEmitter } = require('events');
const serviceRegistry = require('nooblyjs-core');
const { register } = require('./index');

const app = express();
serviceRegistry.initialize(app, new EventEmitter());
const hosted = register(app, serviceRegistry);
const port = Number(process.env.PORT) || 3003;
app.listen(port, () => console.log(`NooblyJS Analytics running on port ${port} at ${hosted.mountPath}`));
