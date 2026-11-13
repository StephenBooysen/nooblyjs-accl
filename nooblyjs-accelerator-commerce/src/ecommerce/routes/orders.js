/**
 * @fileoverview Orders and order tracking
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // ===== ORDERS API =====

  // Create new order
  app.post(`/applications/${app_path}/api/orders`, requireAuth, async (req, res) => {
    try {
      const { items, shippingAddress, billingAddress, paymentMethod } = req.body;

      if (!items || items.length === 0) {
        return res.status(400).json({ error: 'Order items are required' });
      }

      if (!shippingAddress) {
        return res.status(400).json({ error: 'Shipping address is required' });
      }

      // Calculate order total
      const subtotal = calculateOrderTotal(items);
      const taxAmount = subtotal * 0.08; // 8% tax
      const shippingCost = subtotal > 100 ? 0 : 10; // Free shipping over $100
      const totalAmount = subtotal + taxAmount + shippingCost;

      // Generate order number
      const orderNumber = generateOrderNumber();

      // Create order
      const order = {
        orderNumber,
        userId: req.user.id,
        status: 'created',
        items,
        subtotal: Math.round(subtotal * 100) / 100,
        taxAmount: Math.round(taxAmount * 100) / 100,
        shippingCost,
        totalAmount: Math.round(totalAmount * 100) / 100,
        shippingAddress,
        billingAddress: billingAddress || shippingAddress,
        paymentMethod,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const orderUuid = await dataServe.add('orders', order);

      // Store order items
      for (const item of items) {
        await dataServe.add('order_items', {
          orderId: orderUuid,
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          unitPrice: item.price,
          totalPrice: item.price * item.quantity
        });
      }

      // Send order confirmation notification
      notifying.notify('order-events', {
        type: 'order_placed',
        orderId: orderUuid,
        orderNumber,
        userId: req.user.id,
        totalAmount
      });

      res.status(201).json({
        order: { id: orderUuid, ...order }
      });
    } catch (error) {
      logger.error('Error creating order:', error);
      res.status(500).json({ error: 'Failed to create order' });
    }
  });

  // Get order details
  app.get(`/applications/${app_path}/api/orders/:id`, requireAuth, async (req, res) => {
    try {
      const order = await dataServe.getByUuid('orders', req.params.id);

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Check if user owns this order (or is admin)
      if (order.userId !== req.user.id && !req.user.isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Get order items
      const orderItems = await dataServe.jsonFindByPath('order_items', 'orderId', req.params.id);

      res.json({
        order: { ...order, items: orderItems }
      });
    } catch (error) {
      logger.error('Error fetching order:', error);
      res.status(500).json({ error: 'Failed to fetch order' });
    }
  });

  // Track order status (public endpoint)
  app.get(`/applications/${app_path}/api/orders/track/:orderNumber`, async (req, res) => {
    try {
      const orders = await dataServe.jsonFindByPath('orders', 'orderNumber', req.params.orderNumber);

      if (orders.length === 0) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const order = orders[0];

      res.json({
        orderNumber: order.orderNumber,
        status: order.status,
        createdAt: order.createdAt,
        estimatedDelivery: order.estimatedDelivery || null
      });
    } catch (error) {
      logger.error('Error tracking order:', error);
      res.status(500).json({ error: 'Failed to track order' });
    }
  });
};
