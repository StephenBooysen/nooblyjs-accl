/**
 * @fileoverview Admin: inventory management
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // ===== INVENTORY MANAGEMENT =====

  app.get(`/applications/commerce/${app_path}/api/admin/inventory`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const { lowStock = 10 } = req.query;

      const inventoryRecords = await dataServe.jsonFind('inventory', () => true);
      const lowStockItems = inventoryRecords.filter(item => item.available <= parseInt(lowStock));

      // Get product details for low stock items
      const lowStockWithProducts = [];
      for (const item of lowStockItems) {
        try {
          const product = await dataServe.getByUuid('products', item.productId);
          if (product) {
            lowStockWithProducts.push({
              ...item,
              productName: product.name,
              productSku: product.sku
            });
          }
        } catch (error) {
          // Product might have been deleted
        }
      }

      res.json({
        lowStockItems: lowStockWithProducts,
        totalInventoryItems: inventoryRecords.length,
        lowStockCount: lowStockItems.length
      });
    } catch (error) {
      logger.error('Error fetching inventory:', error);
      res.status(500).json({ error: 'Failed to fetch inventory' });
    }
  });

  app.put(`/applications/commerce/${app_path}/api/admin/inventory/:productId`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const { quantity, reason = 'Admin adjustment' } = req.body;

      if (quantity === undefined) {
        return res.status(400).json({ error: 'Quantity is required' });
      }

      const inventoryRecords = await dataServe.jsonFindByPath('inventory', 'productId', req.params.productId);

      if (inventoryRecords.length === 0) {
        return res.status(404).json({ error: 'Inventory record not found' });
      }

      const inventoryRecord = inventoryRecords[0];
      const oldQuantity = inventoryRecord.quantity;

      inventoryRecord.quantity = parseInt(quantity);
      inventoryRecord.available = inventoryRecord.quantity - inventoryRecord.reserved;
      inventoryRecord.lastUpdated = new Date().toISOString();

      await dataServe.remove('inventory', inventoryRecord.id);
      const newInventoryUuid = await dataServe.add('inventory', inventoryRecord);

      // Log inventory change
      await dataServe.add('inventory_logs', {
        productId: req.params.productId,
        oldQuantity,
        newQuantity: inventoryRecord.quantity,
        change: inventoryRecord.quantity - oldQuantity,
        reason,
        adjustedBy: req.user.id,
        adjustedAt: new Date().toISOString()
      });

      res.json({
        inventory: { id: newInventoryUuid, ...inventoryRecord },
        message: 'Inventory updated successfully'
      });
    } catch (error) {
      logger.error('Error updating inventory:', error);
      res.status(500).json({ error: 'Failed to update inventory' });
    }
  });
};
