/**
 * @fileoverview Configuration for the commerce server, read from the environment once.
 *
 * In production (NODE_ENV=production) the required secrets must be set, and loadConfig() throws listing every missing
 * one. In development, a missing secret is replaced by a random value for this process and reported as a warning, so
 * there is never a fixed secret in use.
 *
 * Payments are optional outside production: without STRIPE_SECRET_KEY the server starts, and the payment routes answer
 * 503 `payments not configured`.
 *
 * @module config
 */

'use strict';

const crypto = require('crypto');

const REQUIRED_IN_PRODUCTION = [
  'SESSION_SECRET',
  'JWT_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
];

/**
 * @param {Object} [env=process.env]
 * @return {Object} the configuration; `warnings` lists each development default that was generated
 * @throws {Error} in production when a required variable is missing
 */
function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const warnings = [];

  if (production) {
    const missing = REQUIRED_IN_PRODUCTION.filter((name) => !env[name]);
    if (missing.length) {
      throw new Error(`Missing required configuration in production: ${missing.join(', ')}`);
    }
  }

  const secretOr = (name) => {
    if (env[name]) return env[name];
    warnings.push(`${name} is not set; using a random value for this process only (sessions and tokens reset on restart)`);
    return crypto.randomBytes(32).toString('hex');
  };

  const dataProvider = env.DATA_PROVIDER || 'memory';
  if (!['memory', 'file'].includes(dataProvider)) {
    throw new Error(`DATA_PROVIDER must be memory or file, not ${dataProvider}`);
  }

  return {
    production,
    port: Number(env.PORT) || 3003,
    sessionSecret: secretOr('SESSION_SECRET'),
    jwtSecret: secretOr('JWT_SECRET'),
    dataProvider,
    dataDir: env.DATA_DIR || null,
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || null,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY || null,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || null,
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID || null,
      clientSecret: env.GOOGLE_CLIENT_SECRET || null,
      callbackUrl: env.GOOGLE_CALLBACK_URL || `http://localhost:${Number(env.PORT) || 3003}/applications/commerce/api/auth/google/callback`,
    },
    adminEmail: env.COMMERCE_ADMIN_EMAIL || null,
    adminPassword: env.COMMERCE_ADMIN_PASSWORD || null,
    warnings,
  };
}

module.exports = { loadConfig, REQUIRED_IN_PRODUCTION };
