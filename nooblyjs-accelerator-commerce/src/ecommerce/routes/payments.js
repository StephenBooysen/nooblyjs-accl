/**
 * @fileoverview Stripe payments and webhooks
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // ===== STRIPE PAYMENT API =====

  // Create payment intent
  app.post(`/applications/commerce/${app_path}/api/payments/create-intent`, async (req, res) => {
    if (!stripe) return paymentsUnavailable(res);
    try {
      const { amount, currency = 'usd', metadata = {} } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Valid amount is required' });
      }

      // Create payment intent with Stripe
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency,
        metadata: {
          ...metadata,
          source: 'nooblyjs-ecommerce'
        },
        automatic_payment_methods: {
          enabled: true,
        },
      });

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      });
    } catch (error) {
      logger.error('Error creating payment intent:', error);
      res.status(500).json({ error: 'Failed to create payment intent' });
    }
  });

  // Confirm payment and create order
  app.post(`/applications/commerce/${app_path}/api/payments/confirm`, requireAuth, async (req, res) => {
    if (!stripe) return paymentsUnavailable(res);
    try {
      const {
        paymentIntentId,
        items,
        shippingAddress,
        billingAddress
      } = req.body;

      if (!paymentIntentId || !items || items.length === 0) {
        return res.status(400).json({ error: 'Payment intent ID and items are required' });
      }

      // Retrieve payment intent from Stripe
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (paymentIntent.status !== 'succeeded') {
        return res.status(400).json({ error: 'Payment not confirmed' });
      }

      // Calculate order total
      const subtotal = calculateOrderTotal(items);
      const taxAmount = subtotal * 0.08; // 8% tax
      const shippingCost = subtotal > 100 ? 0 : 10; // Free shipping over $100
      const totalAmount = subtotal + taxAmount + shippingCost;

      // Verify payment amount matches order total
      const expectedAmount = Math.round(totalAmount * 100); // Convert to cents
      if (paymentIntent.amount !== expectedAmount) {
        return res.status(400).json({ error: 'Payment amount mismatch' });
      }

      // Generate order number
      const orderNumber = generateOrderNumber();

      // Create order
      const order = {
        orderNumber,
        userId: req.user.id,
        status: 'processing', // Payment confirmed, now processing
        items,
        subtotal: Math.round(subtotal * 100) / 100,
        taxAmount: Math.round(taxAmount * 100) / 100,
        shippingCost,
        totalAmount: Math.round(totalAmount * 100) / 100,
        shippingAddress,
        billingAddress: billingAddress || shippingAddress,
        paymentMethod: {
          type: 'stripe',
          paymentIntentId: paymentIntent.id,
          last4: paymentIntent.charges?.data[0]?.payment_method_details?.card?.last4 || null,
          brand: paymentIntent.charges?.data[0]?.payment_method_details?.card?.brand || null
        },
        paymentStatus: 'paid',
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

      // Update inventory
      for (const item of items) {
        try {
          const inventoryRecords = await dataServe.jsonFindByPath('inventory', 'productId', item.productId);
          if (inventoryRecords.length > 0) {
            const inventoryRecord = inventoryRecords[0];
            inventoryRecord.quantity = Math.max(0, inventoryRecord.quantity - item.quantity);
            inventoryRecord.available = inventoryRecord.quantity - inventoryRecord.reserved;
            inventoryRecord.lastUpdated = new Date().toISOString();

            await dataServe.remove('inventory', inventoryRecord.id);
            await dataServe.add('inventory', inventoryRecord);
          }
        } catch (invError) {
          logger.error(`Error updating inventory for product ${item.productId}:`, invError);
        }
      }

      // Send order confirmation notification
      notifying.notify('order-events', {
        type: 'order_paid',
        orderId: orderUuid,
        orderNumber,
        userId: req.user.id,
        totalAmount,
        paymentIntentId
      });

      res.status(201).json({
        order: { id: orderUuid, ...order },
        message: 'Payment confirmed and order created successfully'
      });
    } catch (error) {
      logger.error('Error confirming payment:', error);
      res.status(500).json({ error: 'Failed to confirm payment' });
    }
  });

  // Handle Stripe webhooks
  app.post(`/applications/commerce/${app_path}/api/payments/webhook`, express.raw({type: 'application/json'}), async (req, res) => {
    if (!stripe) return paymentsUnavailable(res);
    const sig = req.headers['stripe-signature'];
    // Without the secret an event cannot be verified, so it is refused rather than accepted unsigned.
    const endpointSecret = appConfig.stripe.webhookSecret;
    if (!endpointSecret) return res.status(503).json({ error: 'payments not configured' });

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      logger.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        logger.info(`Payment ${paymentIntent.id} succeeded for amount ${paymentIntent.amount}`);
        break;
      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        logger.error(`Payment ${failedPayment.id} failed`);
        break;
      default:
        logger.info(`Unhandled event type ${event.type}`);
    }

    res.json({received: true});
  });

  // Get Stripe publishable key
  app.get(`/applications/commerce/${app_path}/api/payments/config`, (req, res) => {
    if (!appConfig.stripe.publishableKey) return paymentsUnavailable(res);
    res.json({ publishableKey: appConfig.stripe.publishableKey });
  });
};
