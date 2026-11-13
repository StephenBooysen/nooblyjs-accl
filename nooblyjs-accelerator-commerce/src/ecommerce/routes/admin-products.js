/**
 * @fileoverview Admin: product maintenance and images
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // ===== ADMIN API ENDPOINTS =====

  // Admin Products API
  app.post(`/applications/commerce/${app_path}/api/admin/products`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        name, description, price, salePrice, category, brand, sku,
        tags, status = 'active', inventory = 0
      } = req.body;

      if (!name || !description || !price || !category) {
        return res.status(400).json({ error: 'Name, description, price, and category are required' });
      }

      const product = {
        name,
        description,
        price: parseFloat(price),
        salePrice: salePrice ? parseFloat(salePrice) : null,
        category,
        brand: brand || null,
        sku: sku || `SKU-${Date.now()}`,
        tags: tags || [],
        status,
        inventory: parseInt(inventory),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: req.user.id
      };

      const productUuid = await dataServe.add('products', product);

      // Create initial inventory record
      await dataServe.add('inventory', {
        productId: productUuid,
        quantity: product.inventory,
        reserved: 0,
        available: product.inventory,
        lastUpdated: new Date().toISOString()
      });

      res.status(201).json({
        product: { id: productUuid, ...product }
      });
    } catch (error) {
      logger.error('Error creating product:', error);
      res.status(500).json({ error: 'Failed to create product' });
    }
  });

  app.put(`/applications/commerce/${app_path}/api/admin/products/:id`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const product = await dataServe.getByUuid('products', req.params.id);

      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const {
        name, description, price, salePrice, category, brand,
        tags, status, inventory
      } = req.body;

      // Update product fields
      product.name = name || product.name;
      product.description = description || product.description;
      product.price = price ? parseFloat(price) : product.price;
      product.salePrice = salePrice ? parseFloat(salePrice) : product.salePrice;
      product.category = category || product.category;
      product.brand = brand || product.brand;
      product.tags = tags || product.tags;
      product.status = status || product.status;
      product.updatedAt = new Date().toISOString();
      product.updatedBy = req.user.id;

      // Update inventory if provided
      if (inventory !== undefined) {
        product.inventory = parseInt(inventory);

        // Update inventory record
        const inventoryRecords = await dataServe.jsonFindByPath('inventory', 'productId', req.params.id);
        if (inventoryRecords.length > 0) {
          const inventoryRecord = inventoryRecords[0];
          inventoryRecord.quantity = product.inventory;
          inventoryRecord.available = product.inventory - inventoryRecord.reserved;
          inventoryRecord.lastUpdated = new Date().toISOString();

          await dataServe.remove('inventory', inventoryRecord.id);
          await dataServe.add('inventory', inventoryRecord);
        }
      }

      await dataServe.remove('products', req.params.id);
      const newProductUuid = await dataServe.add('products', product);

      res.json({
        product: { id: newProductUuid, ...product }
      });
    } catch (error) {
      logger.error('Error updating product:', error);
      res.status(500).json({ error: 'Failed to update product' });
    }
  });

  app.delete(`/applications/commerce/${app_path}/api/admin/products/:id`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const product = await dataServe.getByUuid('products', req.params.id);

      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      product.status = 'deleted';
      product.updatedAt = new Date().toISOString();
      product.deletedBy = req.user.id;

      await dataServe.remove('products', req.params.id);
      await dataServe.add('products', product);

      res.json({ message: 'Product deleted successfully' });
    } catch (error) {
      logger.error('Error deleting product:', error);
      res.status(500).json({ error: 'Failed to delete product' });
    }
  });

  // Upload product images
  app.post(`/applications/commerce/${app_path}/api/admin/products/:id/images`, requireAuth, requireAdmin, upload.array('images', 10), async (req, res) => {
    try {
      const product = await dataServe.getByUuid('products', req.params.id);

      if (!product) {
        return res.status(404).json({ error: 'Product not found' });
      }

      const uploadedImages = [];

      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const fileName = `product_${req.params.id}_${Date.now()}_${i}.${file.originalname.split('.').pop()}`;
        const filePath = `products/${req.params.id}/${fileName}`;

        // Upload image using filing service
        await filing.create(filePath, require('stream').Readable.from(file.buffer));

        // Create image record
        const imageRecord = {
          productId: req.params.id,
          fileName,
          filePath,
          originalName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          sortOrder: i,
          isPrimary: i === 0, // First image is primary
          uploadedAt: new Date().toISOString(),
          uploadedBy: req.user.id
        };

        const imageUuid = await dataServe.add('product_images', imageRecord);
        uploadedImages.push({ id: imageUuid, ...imageRecord });
      }

      res.status(201).json({
        message: 'Images uploaded successfully',
        images: uploadedImages
      });
    } catch (error) {
      logger.error('Error uploading product images:', error);
      res.status(500).json({ error: 'Failed to upload images' });
    }
  });
};
