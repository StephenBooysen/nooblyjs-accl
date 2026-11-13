/**
 * @fileoverview User registration, sign-in and profile
 *
 * Routes registered by the eCommerce module (see routes/index.js). Behaviour is unchanged from the single-file version.
 */

'use strict';

module.exports = (ctx) => {
  const {
  app, app_path, dataServe, filing, cache, logger, queue, search, notifying, measuring, eventEmitter, services, requireAuth, requireAdmin, generateOrderNumber, calculateOrderTotal, stripe, paymentsUnavailable, upload, JWT_SECRET, express, bcrypt, jwt, crypto, path, appConfig
} = ctx;

  // ===== USER API =====

  // User registration
  app.post(`/applications/commerce/${app_path}/api/auth/register`, async (req, res) => {
    try {
      const { email, password, firstName, lastName, phone } = req.body;

      if (!email || !password || !firstName || !lastName) {
        return res.status(400).json({ error: 'Email, password, first name, and last name are required' });
      }

      // Check if user already exists
      const existingUsers = await dataServe.jsonFindByPath('users', 'email', email);
      if (existingUsers.length > 0) {
        return res.status(409).json({ error: 'User with this email already exists' });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user
      const user = {
        email,
        password: hashedPassword,
        firstName,
        lastName,
        phone: phone || null,
        isAdmin: false,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const userUuid = await dataServe.add('users', user);

      // Generate JWT token
      const token = jwt.sign({ userId: userUuid }, JWT_SECRET, { expiresIn: '24h' });

      // Remove password from response
      delete user.password;

      res.status(201).json({
        user: { id: userUuid, ...user },
        token
      });
    } catch (error) {
      logger.error('Error registering user:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // User login
  app.post(`/applications/commerce/${app_path}/api/auth/login`, async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      // Find user by email
      const users = await dataServe.jsonFindByPath('users', 'email', email);
      if (users.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = users[0];

      // Verify password
      const isValidPassword = await bcrypt.compare(password, user.password);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Generate JWT token
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '24h' });

      // Remove password from response
      delete user.password;

      res.json({
        user,
        token
      });
    } catch (error) {
      logger.error('Error logging in user:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Get user profile
  app.get(`/applications/commerce/${app_path}/api/user/profile`, requireAuth, async (req, res) => {
    try {
      const user = { ...req.user };
      delete user.password;
      res.json({ user });
    } catch (error) {
      logger.error('Error fetching user profile:', error);
      res.status(500).json({ error: 'Failed to fetch profile' });
    }
  });

  // Update user profile
  app.put(`/applications/commerce/${app_path}/api/user/profile`, requireAuth, async (req, res) => {
    try {
      const { firstName, lastName, phone } = req.body;

      const user = req.user;
      user.firstName = firstName || user.firstName;
      user.lastName = lastName || user.lastName;
      user.phone = phone || user.phone;
      user.updatedAt = new Date().toISOString();

      await dataServe.remove('users', user.id);
      const newUserUuid = await dataServe.add('users', user);

      delete user.password;
      res.json({ user: { id: newUserUuid, ...user } });
    } catch (error) {
      logger.error('Error updating user profile:', error);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });
};
