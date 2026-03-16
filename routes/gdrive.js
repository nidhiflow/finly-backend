import express from 'express';
import { google } from 'googleapis';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/userinfo.email'];

function getServerOAuthCallback() {
    return `${process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001'}/api/gdrive/callback`;
}

function getOAuth2Client() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        getServerOAuthCallback()
    );
}

// GET /api/gdrive/status - Check if Google Drive is connected
router.get('/status', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT value FROM settings WHERE user_id = $1 AND key = $2',
            [req.userId, 'gdrive_connected']
        );
        const { rows: emailRows } = await pool.query(
            'SELECT value FROM settings WHERE user_id = $1 AND key = $2',
            [req.userId, 'gdrive_email']
        );
        const { rows: lastBackupRows } = await pool.query(
            'SELECT value FROM settings WHERE user_id = $1 AND key = $2',
            [req.userId, 'gdrive_last_backup']
        );
        const { rows: autoRows } = await pool.query(
            'SELECT value FROM settings WHERE user_id = $1 AND key = $2',
            [req.userId, 'gdrive_auto_backup']
        );

        res.json({
            connected: rows.length > 0 && rows[0].value === 'true',
            email: emailRows.length > 0 ? emailRows[0].value : null,
            lastBackup: lastBackupRows.length > 0 ? lastBackupRows[0].value : null,
            autoBackup: autoRows.length > 0 && autoRows[0].value === 'true',
        });
    } catch (err) {
        console.error('GDrive status error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/gdrive/auth-url - Generate Google OAuth URL
router.get('/auth-url', async (req, res) => {
    try {
        const oauth2Client = getOAuth2Client();
        const appScheme = typeof req.query.appScheme === 'string' ? req.query.appScheme.trim() : '';
        const isMobile = req.query.mobile === '1' && appScheme;
        const postAuthRedirect = isMobile
            ? `${appScheme}://settings?gdrive=connected`
            : '/settings?gdrive=connected';

        // Store user ID in state parameter so callback knows which user
        const state = Buffer.from(JSON.stringify({
            userId: req.userId,
            postAuthRedirect,
        })).toString('base64');

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent',
            state,
        });

        res.json({ url: authUrl });
    } catch (err) {
        console.error('GDrive auth URL error:', err);
        res.status(500).json({ error: 'Failed to generate auth URL' });
    }
});

// POST /api/gdrive/toggle-auto - Toggle auto backup
router.post('/toggle-auto', async (req, res) => {
    try {
        const { enabled } = req.body;
        await pool.query(
            `INSERT INTO settings (user_id, key, value) VALUES ($1, 'gdrive_auto_backup', $2)
             ON CONFLICT (user_id, key) DO UPDATE SET value = $2`,
            [req.userId, enabled ? 'true' : 'false']
        );
        res.json({ autoBackup: enabled });
    } catch (err) {
        console.error('Toggle auto backup error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/gdrive/backup - Backup to Google Drive
router.post('/backup', async (req, res) => {
    try {
        // Get tokens
        const { rows: tokenRows } = await pool.query(
            'SELECT value FROM settings WHERE user_id = $1 AND key = $2',
            [req.userId, 'gdrive_refresh_token']
        );
        if (tokenRows.length === 0) {
            return res.status(400).json({ error: 'Google Drive not connected. Please connect first.' });
        }

        const oauth2Client = getOAuth2Client();
        oauth2Client.setCredentials({ refresh_token: tokenRows[0].value });

        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        // Gather all user data
        const [transactions, categories, accounts, budgets, settingsData] = await Promise.all([
            pool.query('SELECT * FROM transactions WHERE user_id = $1', [req.userId]),
            pool.query('SELECT * FROM categories WHERE user_id = $1', [req.userId]),
            pool.query('SELECT * FROM accounts WHERE user_id = $1', [req.userId]),
            pool.query('SELECT * FROM budgets WHERE user_id = $1', [req.userId]),
            pool.query("SELECT * FROM settings WHERE user_id = $1 AND key NOT LIKE 'gdrive_%'", [req.userId]),
        ]);

        const backupData = {
            version: 1,
            timestamp: new Date().toISOString(),
            data: {
                transactions: transactions.rows,
                categories: categories.rows,
                accounts: accounts.rows,
                budgets: budgets.rows,
                settings: settingsData.rows,
            },
        };

        const fileName = `finly-backup-${new Date().toISOString().split('T')[0]}.json`;
        const fileContent = JSON.stringify(backupData, null, 2);

        // Check if backup folder exists
        let folderId;
        const folderSearch = await drive.files.list({
            q: "name='Finly Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields: 'files(id)',
        });

        if (folderSearch.data.files.length > 0) {
            folderId = folderSearch.data.files[0].id;
        } else {
            const folder = await drive.files.create({
                requestBody: {
                    name: 'Finly Backups',
                    mimeType: 'application/vnd.google-apps.folder',
                },
                fields: 'id',
            });
            folderId = folder.data.id;
        }

        // Upload backup file
        await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [folderId],
                mimeType: 'application/json',
            },
            media: {
                mimeType: 'application/json',
                body: fileContent,
            },
        });

        // Update last backup time
        const now = new Date().toISOString();
        await pool.query(
            `INSERT INTO settings (user_id, key, value) VALUES ($1, 'gdrive_last_backup', $2)
             ON CONFLICT (user_id, key) DO UPDATE SET value = $2`,
            [req.userId, now]
        );
        await pool.query(
            `INSERT INTO settings (user_id, key, value) VALUES ($1, 'last_backup_at', $2)
             ON CONFLICT (user_id, key) DO UPDATE SET value = $2`,
            [req.userId, now]
        );

        res.json({ success: true, lastBackup: now, fileName });
    } catch (err) {
        console.error('GDrive backup error:', err);
        if (err.code === 401 || err.message?.includes('invalid_grant')) {
            // Token expired or revoked, clean up
            await pool.query("DELETE FROM settings WHERE user_id = $1 AND key LIKE 'gdrive_%'", [req.userId]);
            return res.status(401).json({ error: 'Google Drive access expired. Please reconnect.' });
        }
        res.status(500).json({ error: 'Backup to Google Drive failed' });
    }
});

// POST /api/gdrive/disconnect - Disconnect Google Drive
router.post('/disconnect', async (req, res) => {
    try {
        await pool.query("DELETE FROM settings WHERE user_id = $1 AND key LIKE 'gdrive_%'", [req.userId]);
        res.json({ success: true });
    } catch (err) {
        console.error('GDrive disconnect error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/gdrive/backups - List backups from Google Drive
router.get('/backups', async (req, res) => {
    try {
        const { rows: tokenRows } = await pool.query(
            'SELECT value FROM settings WHERE user_id = $1 AND key = $2',
            [req.userId, 'gdrive_refresh_token']
        );
        if (tokenRows.length === 0) {
            return res.status(400).json({ error: 'Google Drive not connected' });
        }

        const oauth2Client = getOAuth2Client();
        oauth2Client.setCredentials({ refresh_token: tokenRows[0].value });

        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        // Find Finly Backups folder
        const folderSearch = await drive.files.list({
            q: "name='Finly Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            fields: 'files(id)',
        });

        if (folderSearch.data.files.length === 0) {
            return res.json({ backups: [] });
        }

        const folderId = folderSearch.data.files[0].id;
        const fileList = await drive.files.list({
            q: `'${folderId}' in parents and trashed=false`,
            fields: 'files(id, name, createdTime, size)',
            orderBy: 'createdTime desc',
            pageSize: 10,
        });

        res.json({ backups: fileList.data.files });
    } catch (err) {
        console.error('GDrive list backups error:', err);
        res.status(500).json({ error: 'Failed to list backups' });
    }
});

// POST /api/gdrive/restore/:fileId - Restore from Google Drive backup
router.post('/restore/:fileId', async (req, res) => {
    try {
        const { rows: tokenRows } = await pool.query(
            'SELECT value FROM settings WHERE user_id = $1 AND key = $2',
            [req.userId, 'gdrive_refresh_token']
        );
        if (tokenRows.length === 0) {
            return res.status(400).json({ error: 'Google Drive not connected' });
        }

        const oauth2Client = getOAuth2Client();
        oauth2Client.setCredentials({ refresh_token: tokenRows[0].value });

        const drive = google.drive({ version: 'v3', auth: oauth2Client });

        const response = await drive.files.get({
            fileId: req.params.fileId,
            alt: 'media',
        });

        const backupData = response.data;

        if (!backupData || !backupData.data) {
            return res.status(400).json({ error: 'Invalid backup file' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Clear existing data
            await client.query('DELETE FROM transactions WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM budgets WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM categories WHERE user_id = $1 AND parent_id IS NOT NULL', [req.userId]);
            await client.query('DELETE FROM categories WHERE user_id = $1', [req.userId]);
            await client.query('DELETE FROM accounts WHERE user_id = $1', [req.userId]);

            // Restore accounts
            for (const acc of backupData.data.accounts || []) {
                await client.query(
                    'INSERT INTO accounts (id, user_id, name, type, balance, icon, color) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [acc.id, req.userId, acc.name, acc.type, acc.balance || 0, acc.icon, acc.color]
                );
            }

            // Restore categories (parents first)
            const parentCats = (backupData.data.categories || []).filter(c => !c.parent_id);
            const childCats = (backupData.data.categories || []).filter(c => c.parent_id);
            for (const cat of parentCats) {
                await client.query(
                    'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [cat.id, req.userId, cat.name, cat.type, cat.icon, cat.color, null]
                );
            }
            for (const cat of childCats) {
                await client.query(
                    'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [cat.id, req.userId, cat.name, cat.type, cat.icon, cat.color, cat.parent_id]
                );
            }

            // Restore transactions
            for (const tx of backupData.data.transactions || []) {
                await client.query(
                    'INSERT INTO transactions (id, user_id, type, amount, category_id, account_id, to_account_id, date, note, photo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                    [tx.id, req.userId, tx.type, tx.amount, tx.category_id, tx.account_id, tx.to_account_id, tx.date, tx.note, tx.photo]
                );
            }

            // Restore budgets
            for (const b of backupData.data.budgets || []) {
                await client.query(
                    'INSERT INTO budgets (id, user_id, category_id, amount, period) VALUES ($1, $2, $3, $4, $5)',
                    [b.id, req.userId, b.category_id, b.amount, b.period]
                );
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        res.json({ success: true, message: 'Data restored from Google Drive backup' });
    } catch (err) {
        console.error('GDrive restore error:', err);
        res.status(500).json({ error: 'Restore from Google Drive failed' });
    }
});

export default router;
