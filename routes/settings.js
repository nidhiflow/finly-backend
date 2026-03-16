import express from 'express';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

// GET /api/settings
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT key, value FROM settings WHERE user_id = $1', [req.userId]);
        const settings = {};
        rows.forEach(row => { settings[row.key] = row.value; });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/settings
router.put('/', async (req, res) => {
    try {
        for (const [key, value] of Object.entries(req.body)) {
            await pool.query(
                'INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT(user_id, key) DO UPDATE SET value = EXCLUDED.value',
                [req.userId, key, String(value)]
            );
        }

        const { rows } = await pool.query('SELECT key, value FROM settings WHERE user_id = $1', [req.userId]);
        const settings = {};
        rows.forEach(row => { settings[row.key] = row.value; });
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/settings/export/csv
router.get('/export/csv', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let query = `SELECT t.date, t.type, t.amount, t.note,
                 c.name as category, a.name as account
                 FROM transactions t
                 LEFT JOIN categories c ON t.category_id = c.id
                 LEFT JOIN accounts a ON t.account_id = a.id
                 WHERE t.user_id = $1`;
        const params = [req.userId];
        let paramIndex = 2;

        if (startDate) { query += ` AND t.date >= $${paramIndex++}`; params.push(startDate); }
        if (endDate) { query += ` AND t.date <= $${paramIndex++}`; params.push(endDate); }
        query += ' ORDER BY t.date DESC';

        const { rows: transactions } = await pool.query(query, params);

        const header = 'Date,Type,Amount,Category,Account,Note\n';
        const csvRows = transactions.map(t =>
            `${t.date},${t.type},${t.amount},"${t.category || ''}","${t.account || ''}","${(t.note || '').replace(/"/g, '""')}"`
        ).join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=finly-transactions.csv');
        res.send(header + csvRows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/settings/backup-status
router.get('/backup-status', async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT value FROM settings WHERE user_id = $1 AND key = 'last_backup_at'",
            [req.userId]
        );
        res.json({
            lastBackupAt: rows[0]?.value || null
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/settings/backup — Export all user data as JSON
router.get('/backup', async (req, res) => {
    try {
        const userId = req.userId;

        const [transactions, categories, accounts, budgets, settings] = await Promise.all([
            pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC', [userId]),
            pool.query('SELECT * FROM categories WHERE user_id = $1', [userId]),
            pool.query('SELECT * FROM accounts WHERE user_id = $1', [userId]),
            pool.query('SELECT * FROM budgets WHERE user_id = $1', [userId]),
            pool.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]),
        ]);

        const backup = {
            version: 1,
            app: 'Finly',
            createdAt: new Date().toISOString(),
            data: {
                transactions: transactions.rows,
                categories: categories.rows,
                accounts: accounts.rows,
                budgets: budgets.rows,
                settings: settings.rows,
            }
        };

        // Update last_backup_at
        await pool.query(
            "INSERT INTO settings (user_id, key, value) VALUES ($1, 'last_backup_at', $2) ON CONFLICT(user_id, key) DO UPDATE SET value = EXCLUDED.value",
            [userId, new Date().toISOString()]
        );

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=finly-backup-${new Date().toISOString().split('T')[0]}.json`);
        res.json(backup);
    } catch (err) {
        console.error('Backup error:', err);
        res.status(500).json({ error: 'Failed to create backup' });
    }
});

// POST /api/settings/restore — Import backup JSON
router.post('/restore', async (req, res) => {
    try {
        const userId = req.userId;
        const { backup } = req.body;

        if (!backup || !backup.data || backup.app !== 'Finly') {
            return res.status(400).json({ error: 'Invalid backup file' });
        }

        const { transactions, categories, accounts, budgets, settings } = backup.data;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Delete existing data (order matters for foreign keys)
            await client.query('DELETE FROM budgets WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM categories WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
            await client.query("DELETE FROM settings WHERE user_id = $1 AND key != 'last_backup_at'", [userId]);

            // Restore accounts first (referenced by transactions)
            for (const acc of (accounts || [])) {
                await client.query(
                    'INSERT INTO accounts (id, user_id, name, type, balance, icon, color) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [acc.id, userId, acc.name, acc.type, acc.balance, acc.icon, acc.color]
                );
            }

            // Restore categories
            for (const cat of (categories || [])) {
                await client.query(
                    'INSERT INTO categories (id, user_id, name, type, icon, parent_id) VALUES ($1, $2, $3, $4, $5, $6)',
                    [cat.id, userId, cat.name, cat.type, cat.icon, cat.parent_id || null]
                );
            }

            // Restore transactions
            for (const tx of (transactions || [])) {
                await client.query(
                    'INSERT INTO transactions (id, user_id, type, amount, category_id, account_id, to_account_id, date, note, photo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                    [tx.id, userId, tx.type, tx.amount, tx.category_id, tx.account_id, tx.to_account_id, tx.date, tx.note, tx.photo]
                );
            }

            // Restore budgets
            for (const budget of (budgets || [])) {
                await client.query(
                    'INSERT INTO budgets (id, user_id, category_id, amount, period) VALUES ($1, $2, $3, $4, $5)',
                    [budget.id, userId, budget.category_id, budget.amount, budget.period]
                );
            }

            // Restore settings
            for (const setting of (settings || [])) {
                if (setting.key !== 'last_backup_at') {
                    await client.query(
                        'INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT(user_id, key) DO UPDATE SET value = EXCLUDED.value',
                        [userId, setting.key, setting.value]
                    );
                }
            }

            await client.query('COMMIT');
            res.json({
                message: 'Backup restored successfully',
                counts: {
                    transactions: (transactions || []).length,
                    categories: (categories || []).length,
                    accounts: (accounts || []).length,
                    budgets: (budgets || []).length
                }
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Restore error:', err);
        res.status(500).json({ error: 'Failed to restore backup' });
    }
});

export default router;
