/**
 * @fileoverview Admin: order management and refunds
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // Admin Orders API
  app.get(`/applications/${app_path}/api/admin/orders`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const { status, page = 1, limit = 50 } = req.query;

      let orders = [];
      if (status) {
        orders = await dataServe.jsonFindByCriteria('orders', { status });
      } else {
        orders = await dataServe.jsonFind('orders', () => true);
      }

      // Sort by creation date (newest first)
      orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      // Pagination
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + parseInt(limit);
      const paginatedOrders = orders.slice(startIndex, endIndex);

      res.json({
        orders: paginatedOrders,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: orders.length,
          totalPages: Math.ceil(orders.length / limit)
        }
      });
    } catch (error) {
      logger.error('Error fetching admin orders:', error);
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  });

  app.put(`/applications/${app_path}/api/admin/orders/:id/status`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const { status, trackingNumber } = req.body;

      if (!status) {
        return res.status(400).json({ error: 'Status is required' });
      }

      const order = await dataServe.getByUuid('orders', req.params.id);

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      order.status = status;
      order.updatedAt = new Date().toISOString();
      order.updatedBy = req.user.id;

      if (trackingNumber) {
        order.trackingNumber = trackingNumber;
      }

      if (status === 'shipped') {
        order.shippedAt = new Date().toISOString();
        // Calculate estimated delivery (5 business days)
        const estimatedDelivery = new Date();
        estimatedDelivery.setDate(estimatedDelivery.getDate() + 5);
        order.estimatedDelivery = estimatedDelivery.toISOString();
      }

      await dataServe.remove('orders', req.params.id);
      const newOrderUuid = await dataServe.add('orders', order);

      // Send notification about order status change
      notifying.notify('order-events', {
        type: 'order_status_changed',
        orderId: newOrderUuid,
        orderNumber: order.orderNumber,
        oldStatus: req.body.oldStatus,
        newStatus: status,
        userId: order.userId
      });

      res.json({
        order: { id: newOrderUuid, ...order }
      });
    } catch (error) {
      logger.error('Error updating order status:', error);
      res.status(500).json({ error: 'Failed to update order status' });
    }
  });

  // Process refund
  app.post(`/applications/${app_path}/api/admin/orders/:id/refund`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const { amount, reason } = req.body;

      const order = await dataServe.getByUuid('orders', req.params.id);

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      const refundAmount = amount || order.totalAmount;

      // Create refund record
      const refund = {
        orderId: req.params.id,
        orderNumber: order.orderNumber,
        amount: refundAmount,
        reason: reason || 'Admin refund',
        status: 'processed',
        processedAt: new Date().toISOString(),
        processedBy: req.user.id
      };

      const refundUuid = await dataServe.add('refunds', refund);

      // Update order status
      order.status = 'refunded';
      order.refundAmount = refundAmount;
      order.refundedAt = new Date().toISOString();
      order.updatedAt = new Date().toISOString();

      await dataServe.remove('orders', req.params.id);
      await dataServe.add('orders', order);

      res.json({
        message: 'Refund processed successfully',
        refund: { id: refundUuid, ...refund }
      });
    } catch (error) {
      logger.error('Error processing refund:', error);
      res.status(500).json({ error: 'Failed to process refund' });
    }
  });
};
