/**
 * @fileoverview Products, categories, and product search
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // ===== PRODUCTS API =====

  // Get all products with filtering and pagination
  app.get(`/applications/commerce/${app_path}/api/products`, async (req, res) => {
    try {
      const { category, minPrice, maxPrice, search: searchTerm, page = 1, limit = 20 } = req.query;

      let products = await dataServe.jsonFindByCriteria('products', { status: 'active' });

      // Apply filters
      if (category) {
        products = products.filter(p => p.category === category);
      }

      if (minPrice || maxPrice) {
        products = products.filter(p => {
          const price = p.salePrice || p.price;
          return (!minPrice || price >= parseFloat(minPrice)) &&
                 (!maxPrice || price <= parseFloat(maxPrice));
        });
      }

      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        products = products.filter(p =>
          p.name.toLowerCase().includes(term) ||
          p.description.toLowerCase().includes(term) ||
          (p.tags && p.tags.some(tag => tag.toLowerCase().includes(term)))
        );
      }

      // Pagination
      const startIndex = (page - 1) * limit;
      const endIndex = startIndex + parseInt(limit);
      const paginatedProducts = products.slice(startIndex, endIndex);

      res.json({
        products: paginatedProducts,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: products.length,
          totalPages: Math.ceil(products.length / limit)
        }
      });
    } catch (error) {
      logger.error('Error fetching products:', error);
      res.status(500).json({ error: 'Failed to fetch products' });
    }
  });

  // Get product by ID
  app.get(`/applications/commerce/${app_path}/api/products/:id`, async (req, res) => {
    try {
      logger.info(`Fetching product with ID: ${req.params.id}`);

      // Try to find product by UUID first
      let product = await dataServe.getByUuid('products', req.params.id);

      // If not found by UUID, try to find by any field that might match
      if (!product) {
        logger.info(`Product not found by UUID, trying alternative searches...`);

        // Try finding by ID property
        const allProducts = await dataServe.jsonFind('products', () => true);
        product = allProducts.find(p => p.id === req.params.id);

        if (!product) {
          // Try finding by SKU as a last resort
          product = allProducts.find(p => p.sku === req.params.id);
        }

        logger.info(`Alternative search result: ${product ? 'found' : 'not found'}`);
      }

      logger.info(`Product found: ${product ? 'yes' : 'no'}, Status: ${product?.status || 'N/A'}`);

      if (!product) {
        logger.warn(`Product not found in database: ${req.params.id}`);
        return res.status(404).json({ error: 'Product not found' });
      }

      if (product.status !== 'active') {
        logger.warn(`Product found but not active: ${req.params.id}, status: ${product.status}`);
        return res.status(404).json({ error: 'Product not found' });
      }

      // Get product variants
      const variants = await dataServe.jsonFindByPath('product_variants', 'productId', req.params.id);

      // Get product images
      const images = await dataServe.jsonFindByPath('product_images', 'productId', req.params.id);

      res.json({
        ...product,
        variants,
        images
      });
    } catch (error) {
      logger.error('Error fetching product:', error);
      res.status(500).json({ error: 'Failed to fetch product' });
    }
  });

  // Get categories
  app.get(`/applications/commerce/${app_path}/api/categories`, async (req, res) => {
    try {
      const categories = await dataServe.jsonFindByCriteria('categories', { status: 'active' });
      res.json({ categories });
    } catch (error) {
      logger.error('Error fetching categories:', error);
      res.status(500).json({ error: 'Failed to fetch categories' });
    }
  });

  // Debug route to check products in database
  app.get(`/applications/commerce/${app_path}/api/debug/products`, async (req, res) => {
    try {
      const allProducts = await dataServe.jsonFind('products', () => true);
      const activeProducts = await dataServe.jsonFindByCriteria('products', { status: 'active' });

      res.json({
        total: allProducts.length,
        active: activeProducts.length,
        sampleProduct: allProducts[0] || null,
        allProducts: allProducts.map(p => ({ id: p.id, name: p.name, status: p.status, sku: p.sku }))
      });
    } catch (error) {
      logger.error('Error in debug route:', error);
      res.status(500).json({ error: 'Debug failed', details: error.message });
    }
  });

  // Trigger manual seeding (for debugging)
  app.post(`/applications/commerce/${app_path}/api/debug/seed`, async (req, res) => {
    try {
      const SeedService = require('../services/seedService');
      const seedService = new SeedService(services);

      await seedService.seedAll();
      logger.info('Manual seeding completed');

      res.json({ message: 'Seeding completed successfully' });
    } catch (error) {
      logger.error('Error in manual seeding:', error);
      res.status(500).json({ error: 'Seeding failed', details: error.message });
    }
  });

  // Search products
  app.get(`/applications/commerce/${app_path}/api/search`, async (req, res) => {
    try {
      const { q: query, category, limit = 20 } = req.query;

      if (!query) {
        return res.status(400).json({ error: 'Search query is required' });
      }

      let products = await dataServe.jsonFind('products', product => {
        if (product.status !== 'active') return false;

        const searchableText = [
          product.name,
          product.description,
          product.brand || '',
          (product.tags || []).join(' ')
        ].join(' ').toLowerCase();

        return searchableText.includes(query.toLowerCase());
      });

      if (category) {
        products = products.filter(p => p.category === category);
      }

      res.json({
        query,
        results: products.slice(0, limit),
        total: products.length
      });
    } catch (error) {
      logger.error('Error searching products:', error);
      res.status(500).json({ error: 'Search failed' });
    }
  });
};
