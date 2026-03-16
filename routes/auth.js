import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { pool, seedDefaultsForUser } from '../db.js';
import { authenticateToken, JWT_SECRET } from '../middleware/auth.js';
import { sendOTP, sendWelcomeEmail, sendLoginAlert } from '../services/email.js';

const router = express.Router();

// Allowed email domains for signup
const ALLOWED_DOMAINS = [
    'gmail.com', 'googlemail.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com',
    'icloud.com', 'me.com', 'mac.com',
    'protonmail.com', 'proton.me',
    'aol.com', 'zoho.com', 'mail.com',
    'rediffmail.com',
];

// Generate 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Hash device info for fingerprinting
function hashDevice(userAgent) {
    return crypto.createHash('sha256').update(userAgent || 'unknown').digest('hex').slice(0, 16);
}

// POST /api/auth/signup — Step 1: Send OTP
router.post('/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Validate email domain
        const emailDomain = email.split('@')[1]?.toLowerCase();
        if (!emailDomain || !ALLOWED_DOMAINS.includes(emailDomain)) {
            return res.status(400).json({ error: 'Please use an official email (Gmail, Outlook, Yahoo, iCloud, ProtonMail, etc.)' });
        }

        // Check if email already registered
        const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.length > 0) {
            return res.status(409).json({ error: 'This email is already registered. Please sign in instead.' });
        }

        // Delete any old OTPs for this email
        await pool.query("DELETE FROM otp_codes WHERE email = $1 AND type = 'signup'", [email]);

        // Generate and store OTP
        const code = generateOTP();
        const hashedPassword = bcrypt.hashSync(password, 10);
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

        await pool.query(
            'INSERT INTO otp_codes (id, email, code, type, name, password, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [uuidv4(), email, code, 'signup', name, hashedPassword, expiresAt]
        );

        // Send OTP email
        await sendOTP(email, code, 'signup');

        res.json({ message: 'Verification code sent to your email', email });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/verify-otp — Step 2: Verify and create account
router.post('/verify-otp', async (req, res) => {
    try {
        const { email, code, type } = req.body;

        if (!email || !code) {
            return res.status(400).json({ error: 'Email and verification code are required' });
        }

        const { rows } = await pool.query(
            'SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND type = $3 AND used = false ORDER BY created_at DESC LIMIT 1',
            [email, code, type || 'signup']
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        const otp = rows[0];

        if (new Date() > new Date(otp.expires_at)) {
            return res.status(400).json({ error: 'Verification code has expired. Please request a new one.' });
        }

        // Mark OTP as used
        await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [otp.id]);

        if (type === 'reset') {
            // Password reset is handled in /reset-password
            return res.json({ message: 'Code verified', verified: true });
        }

        // Create user account
        const userId = uuidv4();
        await pool.query(
            'INSERT INTO users (id, name, email, password, email_verified) VALUES ($1, $2, $3, $4, $5)',
            [userId, otp.name, email, otp.password, true]
        );

        // Seed default data
        await seedDefaultsForUser(userId);

        // Generate JWT
        const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });

        // Send welcome email (small delay to avoid Brevo rate limit)
        setTimeout(() => sendWelcomeEmail(email, otp.name), 2000);

        // Clean up old OTPs
        await pool.query("DELETE FROM otp_codes WHERE email = $1 AND type = 'signup'", [email]);

        res.status(201).json({
            token,
            user: { id: userId, name: otp.name, email },
        });
    } catch (err) {
        console.error('Verify OTP error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/resend-otp
router.post('/resend-otp', async (req, res) => {
    try {
        const { email, type } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Get existing OTP data (for signup, we need the name and password)
        const { rows } = await pool.query(
            'SELECT * FROM otp_codes WHERE email = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1',
            [email, type || 'signup']
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'No pending verification found. Please start over.' });
        }

        const oldOtp = rows[0];

        // Delete old OTPs
        await pool.query('DELETE FROM otp_codes WHERE email = $1 AND type = $2', [email, type || 'signup']);

        // Generate new OTP
        const code = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        await pool.query(
            'INSERT INTO otp_codes (id, email, code, type, name, password, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [uuidv4(), email, code, type || 'signup', oldOtp.name, oldOtp.password, expiresAt]
        );

        await sendOTP(email, code, type || 'signup');

        res.json({ message: 'New verification code sent to your email' });
    } catch (err) {
        console.error('Resend-OTP error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const user = rows[0];

        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Device tracking & alerts
        const userAgent = req.headers['user-agent'] || 'Unknown';
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Unknown';
        const deviceHash = hashDevice(userAgent);

        const { rows: devices } = await pool.query(
            'SELECT * FROM login_devices WHERE user_id = $1 AND device_hash = $2',
            [user.id, deviceHash]
        );

        const isNewDevice = devices.length === 0;
        const lastSeen = devices[0]?.last_seen ? new Date(devices[0].last_seen) : null;
        const hoursSinceLastLogin = lastSeen ? (Date.now() - lastSeen.getTime()) / (1000 * 60 * 60) : Infinity;

        // If inactive for >48 hours (or new device), require login OTP
        if (hoursSinceLastLogin > 48) {
            // Delete old login OTPs
            await pool.query("DELETE FROM otp_codes WHERE email = $1 AND type = 'login'", [email]);

            const code = generateOTP();
            const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
            await pool.query(
                'INSERT INTO otp_codes (id, email, code, type, expires_at) VALUES ($1, $2, $3, $4, $5)',
                [uuidv4(), email, code, 'login', expiresAt]
            );
            await sendOTP(email, code, 'login');

            return res.json({
                requireOTP: true,
                email,
                message: 'For your security, please verify with the code sent to your email.'
            });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

        if (isNewDevice) {
            // Register new device
            await pool.query(
                'INSERT INTO login_devices (id, user_id, device_hash, device_info, ip_address) VALUES ($1, $2, $3, $4, $5)',
                [uuidv4(), user.id, deviceHash, userAgent, ip]
            );
        } else {
            // Update last seen
            await pool.query(
                'UPDATE login_devices SET last_seen = NOW(), ip_address = $1 WHERE user_id = $2 AND device_hash = $3',
                [ip, user.id, deviceHash]
            );
        }

        // Only send login alert if last login was >3 hours ago
        if (hoursSinceLastLogin > 3) {
            const shortDevice = userAgent.length > 100 ? userAgent.slice(0, 100) + '...' : userAgent;
            sendLoginAlert(user.email, shortDevice, ip, isNewDevice);
        }

        res.json({
            token,
            user: { id: user.id, name: user.name, email: user.email },
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/verify-login-otp — Complete login after OTP
router.post('/verify-login-otp', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) {
            return res.status(400).json({ error: 'Email and verification code are required' });
        }

        const { rows: otps } = await pool.query(
            "SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND type = 'login' AND used = false AND expires_at > NOW()",
            [email, code]
        );
        if (otps.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired verification code' });
        }

        // Mark OTP as used
        await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [otps[0].id]);

        // Get user
        const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const user = rows[0];

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

        // Update device tracking
        const userAgent = req.headers['user-agent'] || 'Unknown';
        const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'Unknown';
        const deviceHash = hashDevice(userAgent);

        const { rows: devices } = await pool.query(
            'SELECT * FROM login_devices WHERE user_id = $1 AND device_hash = $2',
            [user.id, deviceHash]
        );

        if (devices.length === 0) {
            await pool.query(
                'INSERT INTO login_devices (id, user_id, device_hash, device_info, ip_address) VALUES ($1, $2, $3, $4, $5)',
                [uuidv4(), user.id, deviceHash, userAgent, ip]
            );
        } else {
            await pool.query(
                'UPDATE login_devices SET last_seen = NOW(), ip_address = $1 WHERE user_id = $2 AND device_hash = $3',
                [ip, user.id, deviceHash]
            );
        }

        // Clean up login OTPs
        await pool.query("DELETE FROM otp_codes WHERE email = $1 AND type = 'login'", [email]);

        res.json({
            token,
            user: { id: user.id, name: user.name, email: user.email },
        });
    } catch (err) {
        console.error('Verify login OTP error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (rows.length === 0) {
            // Don't reveal if email exists or not (security)
            return res.json({ message: 'If this email is registered, a reset code has been sent.' });
        }

        // Delete old reset OTPs
        await pool.query("DELETE FROM otp_codes WHERE email = $1 AND type = 'reset'", [email]);

        const code = generateOTP();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        await pool.query(
            'INSERT INTO otp_codes (id, email, code, type, expires_at) VALUES ($1, $2, $3, $4, $5)',
            [uuidv4(), email, code, 'reset', expiresAt]
        );

        await sendOTP(email, code, 'reset');

        res.json({ message: 'If this email is registered, a reset code has been sent.' });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
    try {
        const { email, code, newPassword } = req.body;

        if (!email || !code || !newPassword) {
            return res.status(400).json({ error: 'Email, code, and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const { rows } = await pool.query(
            "SELECT * FROM otp_codes WHERE email = $1 AND code = $2 AND type = 'reset' AND used = false ORDER BY created_at DESC LIMIT 1",
            [email, code]
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset code' });
        }

        const otp = rows[0];

        if (new Date() > new Date(otp.expires_at)) {
            return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
        }

        // Update password
        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE email = $2', [hashedPassword, email]);

        // Mark OTP as used
        await pool.query('UPDATE otp_codes SET used = true WHERE id = $1', [otp.id]);

        // Clean up
        await pool.query("DELETE FROM otp_codes WHERE email = $1 AND type = 'reset'", [email]);

        res.json({ message: 'Password reset successful. You can now sign in with your new password.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/auth/me
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT id, name, email, created_at FROM users WHERE id = $1', [req.userId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/auth/profile — Update user name
router.put('/profile', authenticateToken, async (req, res) => {
    try {
        const { name } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Name is required' });
        }

        await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), req.userId]);

        const { rows } = await pool.query('SELECT id, name, email, created_at FROM users WHERE id = $1', [req.userId]);
        res.json(rows[0]);
    } catch (err) {
        console.error('Update profile error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/auth/password — Change password
router.put('/password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current password and new password are required' });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }

        const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = rows[0];
        const validPassword = bcrypt.compareSync(currentPassword, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = bcrypt.hashSync(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, req.userId]);

        res.json({ message: 'Password changed successfully' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/auth/account — Delete user account and all data
router.delete('/account', authenticateToken, async (req, res) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password is required to delete your account' });
        }

        const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
        if (rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = rows[0];
        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Incorrect password' });
        }

        // Delete user — cascading deletes will remove all related data
        await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);

        res.json({ message: 'Account deleted successfully' });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
