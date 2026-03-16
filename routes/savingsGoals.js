import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

// GET /api/savings-goals
router.get('/', async (req, res) => {
    try {
        const { month } = req.query; // optional YYYY-MM
        const params = [req.userId];
        let where = 'user_id = $1';
        if (month) {
            params.push(month);
            where += ` AND month = $2`;
        }
        const { rows } = await pool.query(
            `SELECT id, name, target_amount, current_amount, month, category_id, account_id, created_at
             FROM savings_goals
             WHERE ${where}
             ORDER BY created_at DESC`,
            params
        );
        const goalsWithComputed = await Promise.all(rows.map(async (r) => {
            let currentAmount = parseFloat(r.current_amount || 0);
            const hasAccount = !!r.account_id;
            const hasCategory = !!r.category_id;
            const hasMonth = !!r.month;

            // Auto-track when account and/or category is assigned with a month
            if ((hasAccount || hasCategory) && hasMonth) {
                const [y, m] = r.month.split('-');
                const startDate = `${r.month}-01`;
                const lastDay = new Date(Number(y), Number(m), 0).getDate();
                const endDate = `${r.month}-${String(lastDay).padStart(2, '0')}`;

                if (hasAccount && hasCategory) {
                    // Both account + category: income into that account in that category
                    const { rows: sumRows } = await pool.query(
                        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
                         WHERE user_id = $1 AND date >= $2 AND date <= $3
                         AND type = 'income' AND account_id = $4 AND category_id = $5`,
                        [req.userId, startDate, endDate, r.account_id, r.category_id]
                    );
                    currentAmount = parseFloat(sumRows[0]?.total || 0);
                } else if (hasAccount) {
                    // Account only: income + transfers into that account
                    const { rows: sumRows } = await pool.query(
                        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
                         WHERE user_id = $1 AND date >= $2 AND date <= $3
                         AND (
                           (type = 'income' AND account_id = $4)
                           OR (type = 'transfer' AND to_account_id = $4)
                         )`,
                        [req.userId, startDate, endDate, r.account_id]
                    );
                    currentAmount = parseFloat(sumRows[0]?.total || 0);
                } else if (hasCategory) {
                    // Category only: income in that category (including subcategories)
                    const { rows: sumRows } = await pool.query(
                        `SELECT COALESCE(SUM(t.amount), 0) AS total FROM transactions t
                         WHERE t.user_id = $1 AND t.date >= $2 AND t.date <= $3
                         AND t.type = 'income'
                         AND (t.category_id = $4 OR t.category_id IN (
                           SELECT id FROM categories WHERE parent_id = $4
                         ))`,
                        [req.userId, startDate, endDate, r.category_id]
                    );
                    currentAmount = parseFloat(sumRows[0]?.total || 0);
                }
                // Add any manually recorded amount on top of auto-tracked
                currentAmount += parseFloat(r.current_amount || 0);
            }

            // Determine tracking mode for the frontend
            let tracking_mode = 'manual';
            if ((hasAccount || hasCategory) && hasMonth) {
                if (hasAccount && hasCategory) tracking_mode = 'auto_account_category';
                else if (hasAccount) tracking_mode = 'auto_account';
                else tracking_mode = 'auto_category';
            }

            return {
                ...r,
                target_amount: parseFloat(r.target_amount),
                current_amount: currentAmount,
                tracking_mode,
            };
        }));
        res.json(goalsWithComputed);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/savings-goals
router.post('/', async (req, res) => {
    try {
        const { name, target_amount, month, category_id, account_id } = req.body;
        const parsed = parseFloat(target_amount);
        if (!name || !target_amount || !Number.isFinite(parsed) || parsed <= 0) {
            return res.status(400).json({ error: 'Valid name and target amount are required' });
        }
        const id = uuidv4();
        const params = [id, req.userId, name, parsed];
        let columns = 'id, user_id, name, target_amount';
        let values = '$1, $2, $3, $4';
        let pos = 5;
        if (month) {
            columns += ', month';
            values += `, $${pos}`;
            params.push(month);
            pos += 1;
        }
        if (category_id !== undefined && category_id !== null && category_id !== '') {
            columns += ', category_id';
            values += `, $${pos}`;
            params.push(category_id);
            pos += 1;
        }
        if (account_id !== undefined && account_id !== null && account_id !== '') {
            columns += ', account_id';
            values += `, $${pos}`;
            params.push(account_id);
            pos += 1;
        }
        await pool.query(
            `INSERT INTO savings_goals (${columns}) VALUES (${values})`,
            params
        );
        const { rows } = await pool.query('SELECT * FROM savings_goals WHERE id = $1', [id]);
        const g = rows[0];
        res.status(201).json({
            ...g,
            target_amount: parseFloat(g.target_amount),
            current_amount: parseFloat(g.current_amount || 0),
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/savings-goals/:id
router.put('/:id', async (req, res) => {
    try {
        const { rows: existingRows } = await pool.query(
            'SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        );
        if (existingRows.length === 0) return res.status(404).json({ error: 'Savings goal not found' });
        const existing = existingRows[0];

        const name = req.body.name || existing.name;
        const target_amount = req.body.target_amount !== undefined ? parseFloat(req.body.target_amount) : parseFloat(existing.target_amount);
        const current_amount = req.body.current_amount !== undefined ? parseFloat(req.body.current_amount) : parseFloat(existing.current_amount || 0);
        const category_id = req.body.category_id !== undefined ? (req.body.category_id || null) : (existing.category_id ?? null);
        const account_id = req.body.account_id !== undefined ? (req.body.account_id || null) : (existing.account_id ?? null);

        if (!name || !Number.isFinite(target_amount) || target_amount <= 0) {
            return res.status(400).json({ error: 'Valid name and target amount are required' });
        }

        await pool.query(
            'UPDATE savings_goals SET name=$1, target_amount=$2, current_amount=$3, category_id=$4, account_id=$5 WHERE id=$6 AND user_id=$7',
            [name, target_amount, current_amount, category_id, account_id, req.params.id, req.userId]
        );

        const { rows } = await pool.query('SELECT * FROM savings_goals WHERE id = $1', [req.params.id]);
        const g = rows[0];
        res.json({
            ...g,
            target_amount: parseFloat(g.target_amount),
            current_amount: parseFloat(g.current_amount || 0),
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/savings-goals/:id/record — manually add savings
router.post('/:id/record', async (req, res) => {
    try {
        const { amount } = req.body;
        const parsed = parseFloat(amount);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return res.status(400).json({ error: 'A positive amount is required' });
        }
        const { rows: existingRows } = await pool.query(
            'SELECT * FROM savings_goals WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        );
        if (existingRows.length === 0) return res.status(404).json({ error: 'Savings goal not found' });

        const existing = existingRows[0];
        const newAmount = parseFloat(existing.current_amount || 0) + parsed;

        await pool.query(
            'UPDATE savings_goals SET current_amount = $1 WHERE id = $2 AND user_id = $3',
            [newAmount, req.params.id, req.userId]
        );

        const { rows } = await pool.query('SELECT * FROM savings_goals WHERE id = $1', [req.params.id]);
        const g = rows[0];
        res.json({
            ...g,
            target_amount: parseFloat(g.target_amount),
            current_amount: parseFloat(g.current_amount || 0),
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/savings-goals/:id
router.delete('/:id', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id FROM savings_goals WHERE id = $1 AND user_id = $2',
            [req.params.id, req.userId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Savings goal not found' });
        await pool.query('DELETE FROM savings_goals WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;

