/**
 * @fileoverview Content management
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // ===== CONTENT MANAGEMENT API =====

  // Get all content items (public)
  app.get(`/applications/commerce/${app_path}/api/content`, async (req, res) => {
    try {
      const { type, active } = req.query;

      let content = await dataServe.jsonFindAll('content');

      // Filter by type if specified
      if (type) {
        content = content.filter(item => item.type === type);
      }

      // Filter by active status if specified
      if (active !== undefined) {
        const isActive = active === 'true';
        content = content.filter(item => item.active === isActive);
      }

      // Sort by sortOrder and createdAt
      content.sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
          return (a.sortOrder || 0) - (b.sortOrder || 0);
        }
        return new Date(b.createdAt) - new Date(a.createdAt);
      });

      res.json({ content });
    } catch (error) {
      logger.error('Error fetching content:', error);
      res.status(500).json({ error: 'Failed to fetch content' });
    }
  });

  // Get content item by ID (public)
  app.get(`/applications/commerce/${app_path}/api/content/:id`, async (req, res) => {
    try {
      const content = await dataServe.jsonFindById('content', req.params.id);

      if (!content) {
        return res.status(404).json({ error: 'Content not found' });
      }

      res.json({ content });
    } catch (error) {
      logger.error('Error fetching content:', error);
      res.status(500).json({ error: 'Failed to fetch content' });
    }
  });

  // Create content item (admin only)
  app.post(`/applications/commerce/${app_path}/api/content`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const {
        title,
        content,
        type,
        slug,
        excerpt,
        imageUrl,
        videoUrl,
        buttonText,
        buttonUrl,
        backgroundColor,
        textColor,
        active,
        sortOrder,
        startDate,
        endDate,
        metadata
      } = req.body;

      if (!title || !type) {
        return res.status(400).json({ error: 'Title and type are required' });
      }

      // Validate type
      const validTypes = ['banner', 'page', 'announcement', 'promotion', 'hero'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: 'Invalid content type' });
      }

      // Generate slug if not provided
      const contentSlug = slug || title.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .trim();

      // Check if slug already exists
      const existingContent = await dataServe.jsonFindByPath('content', 'slug', contentSlug);
      if (existingContent.length > 0) {
        return res.status(400).json({ error: 'Content with this slug already exists' });
      }

      const contentItem = {
        title,
        content: content || '',
        type,
        slug: contentSlug,
        excerpt: excerpt || '',
        imageUrl: imageUrl || null,
        videoUrl: videoUrl || null,
        buttonText: buttonText || null,
        buttonUrl: buttonUrl || null,
        backgroundColor: backgroundColor || null,
        textColor: textColor || null,
        active: active !== undefined ? active : true,
        sortOrder: sortOrder || 0,
        startDate: startDate || null,
        endDate: endDate || null,
        metadata: metadata || {},
        views: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: req.user.id
      };

      const contentId = await dataServe.add('content', contentItem);

      logger.info(`Content created: ${title} (${contentId})`);

      res.status(201).json({
        content: { id: contentId, ...contentItem },
        message: 'Content created successfully'
      });
    } catch (error) {
      logger.error('Error creating content:', error);
      res.status(500).json({ error: 'Failed to create content' });
    }
  });

  // Update content item (admin only)
  app.put(`/applications/commerce/${app_path}/api/content/:id`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const existingContent = await dataServe.jsonFindById('content', req.params.id);

      if (!existingContent) {
        return res.status(404).json({ error: 'Content not found' });
      }

      const {
        title,
        content,
        type,
        slug,
        excerpt,
        imageUrl,
        videoUrl,
        buttonText,
        buttonUrl,
        backgroundColor,
        textColor,
        active,
        sortOrder,
        startDate,
        endDate,
        metadata
      } = req.body;

      // Validate type if provided
      if (type) {
        const validTypes = ['banner', 'page', 'announcement', 'promotion', 'hero'];
        if (!validTypes.includes(type)) {
          return res.status(400).json({ error: 'Invalid content type' });
        }
      }

      // Check slug uniqueness if changed
      if (slug && slug !== existingContent.slug) {
        const duplicateContent = await dataServe.jsonFindByPath('content', 'slug', slug);
        if (duplicateContent.length > 0) {
          return res.status(400).json({ error: 'Content with this slug already exists' });
        }
      }

      const updatedContent = {
        ...existingContent,
        title: title || existingContent.title,
        content: content !== undefined ? content : existingContent.content,
        type: type || existingContent.type,
        slug: slug || existingContent.slug,
        excerpt: excerpt !== undefined ? excerpt : existingContent.excerpt,
        imageUrl: imageUrl !== undefined ? imageUrl : existingContent.imageUrl,
        videoUrl: videoUrl !== undefined ? videoUrl : existingContent.videoUrl,
        buttonText: buttonText !== undefined ? buttonText : existingContent.buttonText,
        buttonUrl: buttonUrl !== undefined ? buttonUrl : existingContent.buttonUrl,
        backgroundColor: backgroundColor !== undefined ? backgroundColor : existingContent.backgroundColor,
        textColor: textColor !== undefined ? textColor : existingContent.textColor,
        active: active !== undefined ? active : existingContent.active,
        sortOrder: sortOrder !== undefined ? sortOrder : existingContent.sortOrder,
        startDate: startDate !== undefined ? startDate : existingContent.startDate,
        endDate: endDate !== undefined ? endDate : existingContent.endDate,
        metadata: metadata !== undefined ? metadata : existingContent.metadata,
        updatedAt: new Date().toISOString()
      };

      await dataServe.remove('content', req.params.id);
      const contentId = await dataServe.add('content', updatedContent);

      logger.info(`Content updated: ${updatedContent.title} (${contentId})`);

      res.json({
        content: { id: contentId, ...updatedContent },
        message: 'Content updated successfully'
      });
    } catch (error) {
      logger.error('Error updating content:', error);
      res.status(500).json({ error: 'Failed to update content' });
    }
  });

  // Delete content item (admin only)
  app.delete(`/applications/commerce/${app_path}/api/content/:id`, requireAuth, requireAdmin, async (req, res) => {
    try {
      const content = await dataServe.jsonFindById('content', req.params.id);

      if (!content) {
        return res.status(404).json({ error: 'Content not found' });
      }

      await dataServe.remove('content', req.params.id);

      logger.info(`Content deleted: ${content.title} (${req.params.id})`);

      res.json({ message: 'Content deleted successfully' });
    } catch (error) {
      logger.error('Error deleting content:', error);
      res.status(500).json({ error: 'Failed to delete content' });
    }
  });

  // Increment content views (public)
  app.post(`/applications/commerce/${app_path}/api/content/:id/view`, async (req, res) => {
    try {
      const content = await dataServe.jsonFindById('content', req.params.id);

      if (!content) {
        return res.status(404).json({ error: 'Content not found' });
      }

      const updatedContent = {
        ...content,
        views: (content.views || 0) + 1,
        lastViewedAt: new Date().toISOString()
      };

      await dataServe.remove('content', req.params.id);
      await dataServe.add('content', updatedContent);

      res.json({ message: 'View recorded' });
    } catch (error) {
      logger.error('Error recording view:', error);
      res.status(500).json({ error: 'Failed to record view' });
    }
  });
};
