'use strict';
const express = require('express');
const request = require('supertest');
const { register } = require('../index');

describe('analytics register', () => {
  test('serves the screen and status under /applications/analytics', async () => {
    const app = express();
    const hosted = register(app, {}, {});
    expect(hosted.mountPath).toBe('/applications/analytics');
    const page = await request(app).get('/applications/analytics');
    expect(page.status).toBe(200);
    expect(page.text).toContain('No metrics yet');
    const status = await request(app).get('/applications/analytics/api/status');
    expect(status.body.status).toBe('running');
    expect(status.body.sources.map((s) => s.name)).toEqual(['commerce', 'customer', 'infrastructure']);
  });

  test('refuses a mount path outside /applications', () => {
    expect(() => register(express(), {}, { mountPath: '/analytics' })).toThrow(/mountPath/);
  });
});
