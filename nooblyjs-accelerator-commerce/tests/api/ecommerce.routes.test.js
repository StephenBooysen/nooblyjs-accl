/**
 * @fileoverview API tests for the eCommerce routes, using the same wiring as app.js.
 *
 * Covers the README API table: a public happy path, a 401 for admin routes without a bearer token, and a 503 for
 * payment routes when Stripe is not configured.
 */

'use strict';

const express = require('express');
const request = require('supertest');
const { EventEmitter } = require('events');

describe('eCommerce API routes', () => {
  let app;

  beforeAll(() => {
    // Run without Stripe so the payment routes must answer 503.
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    process.env.NODE_ENV = 'test';
    process.env.DATA_PROVIDER = 'memory';

    jest.resetModules();
    const serviceRegistry = require('nooblyjs-core');
    app = express();
    app.use(express.json());
    const eventEmitter = new EventEmitter();
    serviceRegistry.initialize(app, eventEmitter);

    const ecommerce = require('../../src/ecommerce/index');
    ecommerce({ express: app }, eventEmitter, serviceRegistry);
  });

  test('public status endpoint returns 200 and reports running', async () => {
    const res = await request(app).get('/applications/commerce/ecommerce/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
  });

  test('public products endpoint returns 200 with a products array', async () => {
    const res = await request(app).get('/applications/commerce/ecommerce/api/products');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.products)).toBe(true);
  });

  test('admin route without a bearer token returns 401', async () => {
    const res = await request(app).get('/applications/commerce/ecommerce/api/admin/orders');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('No token provided');
  });

  test('admin route with a malformed token returns 401', async () => {
    const res = await request(app)
      .get('/applications/commerce/ecommerce/api/admin/orders')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });

  test('payment intent without Stripe configured returns 503', async () => {
    const res = await request(app)
      .post('/applications/commerce/ecommerce/api/payments/create-intent')
      .send({ amount: 10 });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'payments not configured' });
  });

  test('payment config without Stripe configured returns 503', async () => {
    const res = await request(app).get('/applications/commerce/ecommerce/api/payments/config');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'payments not configured' });
  });
});
