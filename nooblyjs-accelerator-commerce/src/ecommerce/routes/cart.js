/**
 * @fileoverview Shopping cart
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // ===== CART API =====

  // Add item to cart
  app.post(`/applications/${app_path}/api/cart/add`, async (req, res) => {
    try {
      const { sessionId, productId, variantId, quantity = 1 } = req.body;

      if (!sessionId || !productId) {
        return res.status(400).json({ error: 'Session ID and product ID are required' });
      }

      // Get or create cart
      let cart = await cache.get(`cart:${sessionId}`);
      if (!cart) {
        cart = { sessionId, items: [], createdAt: new Date().toISOString() };
      }

      // Get product details
      const product = await dataServe.getByUuid('products', productId);
      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      // Check if item already exists in cart
      const existingItemIndex = cart.items.findIndex(item =>
        item.productId === productId && item.variantId === variantId
      );

      if (existingItemIndex >= 0) {
        cart.items[existingItemIndex].quantity += quantity;
      } else {
        cart.items.push({
          productId,
          variantId,
          name: product.name,
          price: product.salePrice || product.price,
          quantity,
          addedAt: new Date().toISOString()
        });
      }

      cart.updatedAt = new Date().toISOString();

      // Save cart to cache with 24 hour expiry
      await cache.put(`cart:${sessionId}`, cart, 86400);

      res.json({ cart });
    } catch (error) {
      logger.error('Error adding to cart:', error);
      res.status(500).json({ error: 'Failed to add item to cart' });
    }
  });

  // Get cart
  app.get(`/applications/${app_path}/api/cart/:sessionId`, async (req, res) => {
    try {
      const cart = await cache.get(`cart:${req.params.sessionId}`);

      if (!cart) {
        return res.json({ sessionId: req.params.sessionId, items: [] });
      }

      res.json({ cart });
    } catch (error) {
      logger.error('Error fetching cart:', error);
      res.status(500).json({ error: 'Failed to fetch cart' });
    }
  });

  // Update cart item quantity
  app.put(`/applications/${app_path}/api/cart/update`, async (req, res) => {
    try {
      const { sessionId, productId, variantId, quantity } = req.body;

      const cart = await cache.get(`cart:${sessionId}`);
      if (!cart) {
        return res.status(404).json({ error: 'Cart not found' });
      }

      const itemIndex = cart.items.findIndex(item =>
        item.productId === productId && item.variantId === variantId
      );

      if (itemIndex === -1) {
        return res.status(404).json({ error: 'Item not found in cart' });
      }

      if (quantity <= 0) {
        cart.items.splice(itemIndex, 1);
      } else {
        cart.items[itemIndex].quantity = quantity;
      }

      cart.updatedAt = new Date().toISOString();
      await cache.put(`cart:${sessionId}`, cart, 86400);

      res.json({ cart });
    } catch (error) {
      logger.error('Error updating cart:', error);
      res.status(500).json({ error: 'Failed to update cart' });
    }
  });

  // Remove item from cart
  app.delete(`/applications/${app_path}/api/cart/remove`, async (req, res) => {
    try {
      const { sessionId, productId, variantId } = req.body;

      const cart = await cache.get(`cart:${sessionId}`);
      if (!cart) {
        return res.status(404).json({ error: 'Cart not found' });
      }

      cart.items = cart.items.filter(item =>
        !(item.productId === productId && item.variantId === variantId)
      );

      cart.updatedAt = new Date().toISOString();
      await cache.put(`cart:${sessionId}`, cart, 86400);

      res.json({ cart });
    } catch (error) {
      logger.error('Error removing from cart:', error);
      res.status(500).json({ error: 'Failed to remove item from cart' });
    }
  });
};
