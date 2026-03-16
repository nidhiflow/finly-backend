import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDB } from './db.js';

import authRoutes from './routes/auth.js';
import transactionRoutes from './routes/transactions.js';
import categoryRoutes from './routes/categories.js';
import accountRoutes from './routes/accounts.js';
import budgetRoutes from './routes/budgets.js';
import statsRoutes from './routes/stats.js';
import savingsGoalRoutes from './routes/savingsGoals.js';
import settingsRoutes from './routes/settings.js';
import aiRoutes from './routes/ai.js';
import gdriveRoutes from './routes/gdrive.js';
import bookmarkRoutes from './routes/bookmarks.js';
import { google } from 'googleapis';
import { pool } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Trust proxy for IP detection on Render
app.set('trust proxy', true);

// Public Google OAuth callback (no auth token needed)
// NOTE: This must be registered BEFORE app.use('/api/gdrive', gdriveRoutes)
// so that it is not wrapped by authenticateToken.
app.get('/api/gdrive/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        if (!code || !state) return res.status(400).send('Missing code or state');

        const {
            userId,
            postAuthRedirect = '/settings?gdrive=connected',
        } = JSON.parse(Buffer.from(state, 'base64').toString());

        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001'}/api/gdrive/callback`
        );

        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);

        // Get user email from Google
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const { data: profile } = await oauth2.userinfo.get();

        // Store tokens and connection status
        const settings = [
            ['gdrive_connected', 'true'],
            ['gdrive_email', profile.email],
            ['gdrive_refresh_token', tokens.refresh_token],
            ['gdrive_auto_backup', 'false'],
        ];

        for (const [key, value] of settings) {
            if (value) {
                await pool.query(
                    `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)
                     ON CONFLICT (user_id, key) DO UPDATE SET value = $3`,
                    [userId, key, value]
                );
            }
        }

        // Redirect back to the web app or native app scheme after the server callback completes.
        res.redirect(postAuthRedirect);
    } catch (err) {
        console.error('Google OAuth callback error:', err);
        const fallbackRedirect = typeof req.query.state === 'string'
            ? (() => {
                try {
                    const parsed = JSON.parse(Buffer.from(req.query.state, 'base64').toString());
                    return parsed?.postAuthRedirect?.replace('gdrive=connected', 'gdrive=error') || '/settings?gdrive=error';
                } catch {
                    return '/settings?gdrive=error';
                }
            })()
            : '/settings?gdrive=error';
        res.redirect(fallbackRedirect);
    }
});

// Health check (no auth) for app and CI reachability
app.get('/api/health', (req, res) => {
    res.status(200).json({ ok: true });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/budgets', budgetRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/savings-goals', savingsGoalRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/gdrive', gdriveRoutes);
app.use('/api/bookmarks', bookmarkRoutes);

// Initialize database then start server
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`✅ Finly server running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('❌ Failed to initialize database:', err);
    process.exit(1);
});
