import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { uploadImage, deleteImage } from '../services/cloudinary.js';

const router = express.Router();
router.use(authenticateToken);

// Resolve account to balance-holder (parent if this is a sub-account)
async function getBalanceAccountId(client, accountId, userId) {
    if (!accountId) return null;
    const { rows } = await client.query('SELECT id, parent_id FROM accounts WHERE id = $1 AND user_id = $2', [accountId, userId]);
    return rows[0] ? (rows[0].parent_id || rows[0].id) : accountId;
}

// GET /api/transactions
router.get('/', async (req, res) => {
    try {
        const { startDate, endDate, categoryId, accountId, type, search, limit, offset } = req.query;
        let query = `SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
                 a.name as account_name, a.icon as account_icon,
                 parent_acc.name as account_parent_name
                 FROM transactions t
                 LEFT JOIN categories c ON t.category_id = c.id
                 LEFT JOIN accounts a ON t.account_id = a.id
                 LEFT JOIN accounts parent_acc ON a.parent_id = parent_acc.id
                 WHERE t.user_id = $1`;
        const params = [req.userId];
        let paramIndex = 2;

        if (startDate) { query += ` AND t.date >= $${paramIndex++}`; params.push(startDate); }
        if (endDate) { query += ` AND t.date <= $${paramIndex++}`; params.push(endDate); }
        if (categoryId) { query += ` AND (t.category_id = $${paramIndex} OR c.parent_id = $${paramIndex})`; params.push(categoryId); paramIndex++; }
        if (accountId) { query += ` AND t.account_id = $${paramIndex++}`; params.push(accountId); }
        if (type) { query += ` AND t.type = $${paramIndex++}`; params.push(type); }
        if (search) { query += ` AND (t.note ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex} OR a.name ILIKE $${paramIndex})`; params.push(`%${search}%`); paramIndex++; }

        query += ' ORDER BY t.date DESC, t.created_at DESC';

        if (limit) { query += ` LIMIT $${paramIndex++}`; params.push(parseInt(limit)); }
        if (offset) { query += ` OFFSET $${paramIndex++}`; params.push(parseInt(offset)); }

        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        console.error('Get transactions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/transactions/upcoming-recurring — next recurring transactions (date >= today)
router.get('/upcoming-recurring', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const { rows } = await pool.query(
            `SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
             a.name as account_name, parent_acc.name as account_parent_name
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id
             LEFT JOIN accounts a ON t.account_id = a.id
             LEFT JOIN accounts parent_acc ON a.parent_id = parent_acc.id
             WHERE t.user_id = $1 AND t.repeat_group_id IS NOT NULL AND t.date >= $2
             ORDER BY t.date ASC
             LIMIT 5`,
            [req.userId, today]
        );
        res.json(rows);
    } catch (err) {
        console.error('Upcoming recurring error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/transactions/suggestions — top frequent (category, amount, account) from last 30 days
router.get('/suggestions', async (req, res) => {
    try {
        const start = new Date();
        start.setDate(start.getDate() - 30);
        const startDate = start.toISOString().split('T')[0];
        const { rows } = await pool.query(
            `SELECT t.category_id, t.account_id, t.amount, t.type,
                    c.name as category_name, c.icon as category_icon,
                    a.name as account_name,
                    COUNT(*) as cnt
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id
             LEFT JOIN accounts a ON t.account_id = a.id
             WHERE t.user_id = $1 AND t.date >= $2 AND t.type = 'expense' AND t.category_id IS NOT NULL AND t.account_id IS NOT NULL
             GROUP BY t.category_id, t.account_id, t.amount, t.type, c.name, c.icon, a.name
             ORDER BY cnt DESC
             LIMIT 5`,
            [req.userId, startDate]
        );
        res.json(rows.map(r => ({
            categoryId: r.category_id,
            categoryName: r.category_name,
            categoryIcon: r.category_icon,
            accountId: r.account_id,
            accountName: r.account_name,
            amount: parseFloat(r.amount),
            type: r.type || 'expense',
        })));
    } catch (err) {
        console.error('Suggestions error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/transactions/:id
router.get('/:id', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
       a.name as account_name, parent_acc.name as account_parent_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       LEFT JOIN accounts parent_acc ON a.parent_id = parent_acc.id
       WHERE t.id = $1 AND t.user_id = $2`,
            [req.params.id, req.userId]
        );

        if (rows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/transactions
router.post('/', async (req, res) => {
    try {
        const { type, amount, category_id, account_id, to_account_id, date, note, photo, repeat_months } = req.body;

        if (!type || !amount || !account_id || !date) {
            return res.status(400).json({ error: 'Type, amount, account_id, and date are required' });
        }

        const repeatMonthsNum = Math.min(Math.max(parseInt(repeat_months, 10) || 1, 1), 24);
        const isRepeat = repeatMonthsNum > 1;

        // Upload photo to Cloudinary if provided
        let photoUrl = null;
        if (photo) {
            photoUrl = await uploadImage(photo);
        }

        const baseDate = new Date(date);
        const dateStr = baseDate.toISOString().split('T')[0];
        const repeatGroupId = isRepeat ? uuidv4() : null;
        const repeatEndDate = isRepeat
            ? new Date(baseDate.getFullYear(), baseDate.getMonth() + repeatMonthsNum - 1, baseDate.getDate()).toISOString().split('T')[0]
            : null;

        const client = await pool.connect();
        let firstId = null;
        try {
            await client.query('BEGIN');

            const balanceAccountId = await getBalanceAccountId(client, account_id, req.userId);
            const balanceToAccountId = to_account_id ? await getBalanceAccountId(client, to_account_id, req.userId) : null;

            firstId = uuidv4();
            await client.query(
                `INSERT INTO transactions (id, user_id, type, amount, category_id, account_id, to_account_id, date, note, photo, repeat_group_id, repeat_end_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    firstId, req.userId, type, amount, category_id || null, account_id, to_account_id || null, dateStr, note || '', photoUrl,
                    repeatGroupId, repeatEndDate
                ]
            );

            if (type === 'income') {
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [amount, balanceAccountId, req.userId]);
            } else if (type === 'expense') {
                await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [amount, balanceAccountId, req.userId]);
            } else if (type === 'transfer') {
                await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [amount, balanceAccountId, req.userId]);
                if (balanceToAccountId) {
                    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [amount, balanceToAccountId, req.userId]);
                }
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        try {
            const { rows: created } = await pool.query('SELECT * FROM transactions WHERE id = $1', [firstId]);
            return res.status(201).json(created[0]);
        } catch (e) {
            console.error('Create transaction: post-commit fetch failed', e);
            return res.status(201).json({ id: firstId, date: dateStr, type, amount, user_id: req.userId, account_id, to_account_id: to_account_id || null, category_id: category_id || null, note: note || '', photo: photoUrl, repeat_group_id: repeatGroupId, repeat_end_date: repeatEndDate });
        }
    } catch (err) {
        console.error('Create transaction error:', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

// POST /api/transactions/process-recurring — create next due occurrence for each repeat group
router.post('/process-recurring', async (req, res) => {
    try {
        const client = await pool.connect();
        try {
            const { rows: groups } = await client.query(
                `SELECT repeat_group_id, MAX(date) as max_date, MAX(id) as latest_id
                 FROM transactions WHERE user_id = $1 AND repeat_group_id IS NOT NULL AND repeat_end_date IS NOT NULL
                 GROUP BY repeat_group_id`,
                [req.userId]
            );
            const today = new Date().toISOString().split('T')[0];
            for (const g of groups) {
                const { rows: latest } = await client.query(
                    'SELECT * FROM transactions WHERE id = $1 AND user_id = $2', [g.latest_id, req.userId]
                );
                if (latest.length === 0) continue;
                const tx = latest[0];
                const maxDate = new Date(g.max_date);
                const nextDate = new Date(maxDate.getFullYear(), maxDate.getMonth() + 1, maxDate.getDate());
                const nextStr = nextDate.toISOString().split('T')[0];
                if (nextStr > tx.repeat_end_date || nextStr > today) continue;
                const { rows: existing } = await client.query(
                    'SELECT id FROM transactions WHERE user_id = $1 AND repeat_group_id = $2 AND date = $3',
                    [req.userId, tx.repeat_group_id, nextStr]
                );
                if (existing.length > 0) continue;
                const balanceAccountId = await getBalanceAccountId(client, tx.account_id, req.userId);
                const balanceToAccountId = tx.to_account_id ? await getBalanceAccountId(client, tx.to_account_id, req.userId) : null;
                const newId = uuidv4();
                await client.query(
                    `INSERT INTO transactions (id, user_id, type, amount, category_id, account_id, to_account_id, date, note, photo, repeat_group_id, repeat_end_date)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [newId, req.userId, tx.type, tx.amount, tx.category_id, tx.account_id, tx.to_account_id, nextStr, tx.note || '', tx.photo, tx.repeat_group_id, tx.repeat_end_date]
                );
                if (tx.type === 'income') {
                    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [tx.amount, balanceAccountId, req.userId]);
                } else if (tx.type === 'expense') {
                    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [tx.amount, balanceAccountId, req.userId]);
                } else if (tx.type === 'transfer') {
                    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [tx.amount, balanceAccountId, req.userId]);
                    if (balanceToAccountId) {
                        await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [tx.amount, balanceToAccountId, req.userId]);
                    }
                }
            }
        } finally {
            client.release();
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Process recurring error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/transactions/:id
router.put('/:id', async (req, res) => {
    try {
        const { rows: existingRows } = await pool.query('SELECT * FROM transactions WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existingRows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
        const existing = existingRows[0];

        const { type, amount, category_id, account_id, to_account_id, date, note, photo } = req.body;

        // Upload new photo to Cloudinary if it's base64
        let photoUrl = photo || null;
        if (photo && !photo.startsWith('http')) {
            photoUrl = await uploadImage(photo);
            // Delete old photo from Cloudinary if it existed
            if (existing.photo) await deleteImage(existing.photo);
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const oldBalanceAcc = await getBalanceAccountId(client, existing.account_id, req.userId);
            const oldBalanceToAcc = existing.to_account_id ? await getBalanceAccountId(client, existing.to_account_id, req.userId) : null;
            const newBalanceAcc = await getBalanceAccountId(client, account_id, req.userId);
            const newBalanceToAcc = to_account_id ? await getBalanceAccountId(client, to_account_id, req.userId) : null;

            // Revert old balance
            if (existing.type === 'income') {
                await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [existing.amount, oldBalanceAcc, req.userId]);
            } else if (existing.type === 'expense') {
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [existing.amount, oldBalanceAcc, req.userId]);
            } else if (existing.type === 'transfer') {
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [existing.amount, oldBalanceAcc, req.userId]);
                if (oldBalanceToAcc) {
                    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [existing.amount, oldBalanceToAcc, req.userId]);
                }
            }

            await client.query(
                `UPDATE transactions SET type=$1, amount=$2, category_id=$3, account_id=$4, to_account_id=$5, date=$6, note=$7, photo=$8 WHERE id=$9 AND user_id=$10`,
                [type, amount, category_id || null, account_id, to_account_id || null, date, note || '', photoUrl, req.params.id, req.userId]
            );

            // Apply new balance
            if (type === 'income') {
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [amount, newBalanceAcc, req.userId]);
            } else if (type === 'expense') {
                await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [amount, newBalanceAcc, req.userId]);
            } else if (type === 'transfer') {
                await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [amount, newBalanceAcc, req.userId]);
                if (newBalanceToAcc) {
                    await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [amount, newBalanceToAcc, req.userId]);
                }
            }

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        const { rows } = await pool.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
        res.json(rows[0]);
    } catch (err) {
        console.error('Update transaction error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/transactions/:id/repeat-off — turn off repeat for all in group
router.put('/:id/repeat-off', async (req, res) => {
    try {
        const { rows: existingRows } = await pool.query('SELECT * FROM transactions WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existingRows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
        const groupId = existingRows[0].repeat_group_id;
        if (!groupId) return res.status(400).json({ error: 'This transaction is not a repeating one' });
        await pool.query(
            'UPDATE transactions SET repeat_group_id = NULL, repeat_end_date = NULL WHERE user_id = $1 AND repeat_group_id = $2',
            [req.userId, groupId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/transactions/:id
router.delete('/:id', async (req, res) => {
    try {
        const { rows: existingRows } = await pool.query('SELECT * FROM transactions WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existingRows.length === 0) return res.status(404).json({ error: 'Transaction not found' });
        const existing = existingRows[0];

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const balanceAcc = await getBalanceAccountId(client, existing.account_id, req.userId);
            const balanceToAcc = existing.to_account_id ? await getBalanceAccountId(client, existing.to_account_id, req.userId) : null;

            if (existing.type === 'income') {
                await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [existing.amount, balanceAcc, req.userId]);
            } else if (existing.type === 'expense') {
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [existing.amount, balanceAcc, req.userId]);
            } else if (existing.type === 'transfer') {
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3', [existing.amount, balanceAcc, req.userId]);
                if (balanceToAcc) {
                    await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3', [existing.amount, balanceToAcc, req.userId]);
                }
            }
            await client.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);

            // Clean up photo from Cloudinary
            if (existing.photo) await deleteImage(existing.photo);

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Delete transaction error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
