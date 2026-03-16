import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { sendBudgetAlertConsolidated } from '../services/email.js';

const router = express.Router();
router.use(authenticateToken);

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// GET /api/budgets
router.get('/', async (req, res) => {
    try {
        const { rows: budgets } = await pool.query(
            `SELECT b.*, c.name as category_name, c.icon as category_icon, c.color as category_color
       FROM budgets b
       LEFT JOIN categories c ON b.category_id = c.id
       WHERE b.user_id = $1`, [req.userId]
        );

        const { month } = req.query; // optional: e.g., '2026-02'
        const now = month ? new Date(month + '-15') : new Date();
        const budgetsWithUsage = await Promise.all(budgets.map(async budget => {
            let startDate, endDate;
            const year = now.getFullYear();
            const m = now.getMonth();

            if (budget.period === 'monthly') {
                startDate = new Date(year, m, 1).toISOString().split('T')[0];
                endDate = new Date(year, m + 1, 0).toISOString().split('T')[0];
            } else if (budget.period === 'weekly') {
                const day = now.getDay();
                const diff = now.getDate() - day + (day === 0 ? -6 : 1);
                const weekStart = new Date(now);
                weekStart.setDate(diff);
                startDate = weekStart.toISOString().split('T')[0];
                const weekEnd = new Date(weekStart);
                weekEnd.setDate(weekEnd.getDate() + 6);
                endDate = weekEnd.toISOString().split('T')[0];
            } else {
                startDate = `${year}-01-01`;
                endDate = `${year}-12-31`;
            }

            const { rows: usage } = await pool.query(
                `SELECT COALESCE(SUM(amount), 0) as spent FROM transactions
         WHERE user_id = $1 AND (category_id = $2 OR category_id IN (SELECT id FROM categories WHERE parent_id = $2)) AND type = 'expense' AND date >= $3 AND date <= $4`,
                [req.userId, budget.category_id, startDate, endDate]
            );

            const budgetAmount = parseFloat(budget.amount);
            const spent = parseFloat(usage[0].spent);
            return { ...budget, amount: budgetAmount, spent, remaining: budgetAmount - spent };
        }));

        // Consolidated budget alert: one email per user per 24h for all budgets ≥ 90%
        const { rows: userRow } = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
        const userEmail = userRow[0]?.email;
        if (userEmail) {
            const alertItems = budgetsWithUsage
                .map(b => ({
                    budgetName: b.category_name || 'Budget',
                    pct: b.amount > 0 ? Math.min((b.spent / b.amount) * 100, 100) : 0,
                    amount: b.amount,
                    spent: b.spent,
                }))
                .filter(b => b.pct >= 90);
            if (alertItems.length > 0) {
                const { rows: alertSettings } = await pool.query(
                    "SELECT key, value FROM settings WHERE user_id = $1 AND key = 'budget_alert_consolidated'",
                    [req.userId]
                );
                const lastSent = alertSettings[0]?.value;
                const nowMs = Date.now();
                if (!lastSent || (nowMs - new Date(lastSent).getTime() > ALERT_COOLDOWN_MS)) {
                    await sendBudgetAlertConsolidated(userEmail, alertItems);
                    await pool.query(
                        'INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (user_id, key) DO UPDATE SET value = $3',
                        [req.userId, 'budget_alert_consolidated', new Date().toISOString()]
                    );
                }
            }
        }

        res.json(budgetsWithUsage);
    } catch (err) {
        console.error('Get budgets error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/budgets
router.post('/', async (req, res) => {
    try {
        const { category_id, amount, period } = req.body;
        if (!category_id || !amount || !period) {
            return res.status(400).json({ error: 'Category, amount, and period are required' });
        }

        const { rows: existing } = await pool.query(
            'SELECT id FROM budgets WHERE user_id = $1 AND category_id = $2 AND period = $3',
            [req.userId, category_id, period]
        );

        if (existing.length > 0) {
            return res.status(409).json({ error: 'Budget already exists for this category and period' });
        }

        const id = uuidv4();
        await pool.query(
            'INSERT INTO budgets (id, user_id, category_id, amount, period) VALUES ($1, $2, $3, $4, $5)',
            [id, req.userId, category_id, amount, period]
        );

        const { rows } = await pool.query('SELECT * FROM budgets WHERE id = $1', [id]);
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/budgets/:id
router.put('/:id', async (req, res) => {
    try {
        const { rows: existing } = await pool.query('SELECT * FROM budgets WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Budget not found' });

        const { amount, period } = req.body;
        await pool.query('UPDATE budgets SET amount=$1, period=$2 WHERE id=$3 AND user_id=$4',
            [amount || existing[0].amount, period || existing[0].period, req.params.id, req.userId]);

        const { rows } = await pool.query('SELECT * FROM budgets WHERE id = $1', [req.params.id]);
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/budgets/:id
router.delete('/:id', async (req, res) => {
    try {
        const { rows: existing } = await pool.query('SELECT * FROM budgets WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Budget not found' });

        await pool.query('DELETE FROM budgets WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
