/**
 * @fileoverview eCommerce Routes Manager
 *
 * @author NooblyJS Core Team
 * @version 1.0.0
 */

'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const express = require('express');
const { loadConfig } = require('../../config');
const appConfig = loadConfig({ ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' });
// Stripe is optional outside production: without a key the payment routes answer 503.
const stripe = appConfig.stripe.secretKey ? require('stripe')(appConfig.stripe.secretKey) : null;
const paymentsUnavailable = (res) => res.status(503).json({ error: 'payments not configured' });

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const JWT_SECRET = appConfig.jwtSecret;

/**
 * Configures and registers eCommerce routes with the Express application.
 * Implements comprehensive API endpoints for storefront and admin functionality.
 *
 * @param {Object} options - Configuration options object
 * @param {Object} options.express - The Express application instance
 * @param {Object} eventEmitter - Event emitter for logging and notifications
 * @param {Object} services - NooblyJS Core services
 * @return {void}
 */

function createContext(options, eventEmitter, services) {
  const app = options.express;
  const app_path = options.path || 'ecommerce';
  const { dataServe, filing, cache, logger, queue, search, notifying, measuring } = services;

  // Middleware for API key validation (admin routes)
  const requireAuth = async (req, res, next) => {
    try {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await dataServe.getByUuid('users', decoded.userId);

      if (!user) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      req.user = user;
      next();
    } catch (error) {
      res.status(401).json({ error: 'Invalid token' });
    }
  };

  const requireAdmin = async (req, res, next) => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  // ===== UTILITY FUNCTIONS =====

  const generateOrderNumber = () => {
    return 'ORD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
  };

  const calculateOrderTotal = (items) => {
    return items.reduce((total, item) => total + (item.price * item.quantity), 0);
  };


  return {
    app,
    app_path,
    dataServe,
    filing,
    cache,
    logger,
    queue,
    search,
    notifying,
    measuring,
    eventEmitter,
    services,
    requireAuth,
    requireAdmin,
    generateOrderNumber,
    calculateOrderTotal,
    stripe,
    paymentsUnavailable,
    upload,
    JWT_SECRET,
    express,
    bcrypt,
    jwt,
    crypto,
    path,
    appConfig,
  };
}

module.exports = { createContext };
