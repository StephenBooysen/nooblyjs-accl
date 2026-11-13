/**
 * @fileoverview Admin: sales, product and customer analytics
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // Admin Analytics API
  app.get(`/applications/commerce/${app_path}/api/admin/analytics/sales`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const { startDate, endDate } = req.query;

      let orders = await dataServe.jsonFind('orders', order => {
        if (order.status === 'cancelled' || order.status === 'refunded') return false;

        if (startDate || endDate) {
          const orderDate = new Date(order.createdAt);
          if (startDate && orderDate < new Date(startDate)) return false;
          if (endDate && orderDate > new Date(endDate)) return false;
        }

        return true;
      });

      const totalRevenue = orders.reduce((sum, order) => sum + order.totalAmount, 0);
      const totalOrders = orders.length;
      const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

      // Group by date for trend analysis
      const dailySales = {};
      orders.forEach(order => {
        const date = order.createdAt.split('T')[0];
        if (!dailySales[date]) {
          dailySales[date] = { revenue: 0, orders: 0 };
        }
        dailySales[date].revenue += order.totalAmount;
        dailySales[date].orders += 1;
      });

      res.json({
        summary: {
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          totalOrders,
          averageOrderValue: Math.round(averageOrderValue * 100) / 100
        },
        dailySales,
        period: {
          startDate: startDate || orders[orders.length - 1]?.createdAt?.split('T')[0],
          endDate: endDate || orders[0]?.createdAt?.split('T')[0]
        }
      });
    } catch (error) {
      logger.error('Error fetching sales analytics:', error);
      res.status(500).json({ error: 'Failed to fetch sales analytics' });
    }
  });

  app.get(`/applications/commerce/${app_path}/api/admin/analytics/products`, requireAuth, requireAdmin, async (req, res) => {
    try {
      // Get all order items to analyze product performance
      const orderItems = await dataServe.jsonFind('order_items', () => true);

      // Group by product
      const productStats = {};
      for (const item of orderItems) {
        if (!productStats[item.productId]) {
          productStats[item.productId] = {
            productId: item.productId,
            totalQuantitySold: 0,
            totalRevenue: 0,
            orderCount: 0
          };
        }

        productStats[item.productId].totalQuantitySold += item.quantity;
        productStats[item.productId].totalRevenue += item.totalPrice;
        productStats[item.productId].orderCount += 1;
      }

      // Get product details and combine with stats
      const productPerformance = [];
      for (const [productId, stats] of Object.entries(productStats)) {
        try {
          const product = await dataServe.getByUuid('products', productId);
          if (product) {
            productPerformance.push({
              ...stats,
              productName: product.name,
              category: product.category,
              price: product.price
            });
          }
        } catch (error) {
          // Product might have been deleted, skip it
        }
      }

      // Sort by revenue
      productPerformance.sort((a, b) => b.totalRevenue - a.totalRevenue);

      res.json({
        topSellingProducts: productPerformance.slice(0, 10),
        allProductPerformance: productPerformance
      });
    } catch (error) {
      logger.error('Error fetching product analytics:', error);
      res.status(500).json({ error: 'Failed to fetch product analytics' });
    }
  });

  app.get(`/applications/commerce/${app_path}/api/admin/analytics/customers`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const users = await dataServe.jsonFindByCriteria('users', { status: 'active' });
      const orders = await dataServe.jsonFind('orders', () => true);

      const totalCustomers = users.length;
      const totalOrders = orders.length;

      // Calculate customer lifetime value
      const customerStats = {};
      orders.forEach(order => {
        if (!customerStats[order.userId]) {
          customerStats[order.userId] = {
            totalOrders: 0,
            totalSpent: 0,
            firstOrder: order.createdAt,
            lastOrder: order.createdAt
          };
        }

        customerStats[order.userId].totalOrders += 1;
        customerStats[order.userId].totalSpent += order.totalAmount;

        if (order.createdAt < customerStats[order.userId].firstOrder) {
          customerStats[order.userId].firstOrder = order.createdAt;
        }
        if (order.createdAt > customerStats[order.userId].lastOrder) {
          customerStats[order.userId].lastOrder = order.createdAt;
        }
      });

      const customersWithOrders = Object.keys(customerStats).length;
      const averageOrdersPerCustomer = customersWithOrders > 0 ? totalOrders / customersWithOrders : 0;

      res.json({
        summary: {
          totalCustomers,
          customersWithOrders,
          averageOrdersPerCustomer: Math.round(averageOrdersPerCustomer * 100) / 100
        },
        customerStats: Object.entries(customerStats).map(([userId, stats]) => ({
          userId,
          ...stats,
          averageOrderValue: stats.totalOrders > 0 ? stats.totalSpent / stats.totalOrders : 0
        })).sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 50) // Top 50 customers
      });
    } catch (error) {
      logger.error('Error fetching customer analytics:', error);
      res.status(500).json({ error: 'Failed to fetch customer analytics' });
    }
  });
};
