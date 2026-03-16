import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

// GET /api/accounts
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at', [req.userId]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/accounts
router.post('/', async (req, res) => {
    try {
        const { name, type, balance, icon, color, parent_id } = req.body;
        if (!name || !type) return res.status(400).json({ error: 'Name and type are required' });

        const id = uuidv4();
        const balanceVal = parent_id ? 0 : (balance || 0);
        await pool.query(
            'INSERT INTO accounts (id, user_id, parent_id, name, type, balance, icon, color) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
            [id, req.userId, parent_id || null, name, type, balanceVal, icon || '💰', color || '#3498DB']
        );

        const { rows } = await pool.query('SELECT * FROM accounts WHERE id = $1', [id]);
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/accounts/:id
router.put('/:id', async (req, res) => {
    try {
        const { rows: existing } = await pool.query('SELECT * FROM accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Account not found' });

        const { name, type, balance, icon, color } = req.body;
        const isChild = !!existing[0].parent_id;
        const balanceVal = isChild ? 0 : (balance !== undefined ? balance : existing[0].balance);
        await pool.query('UPDATE accounts SET name=$1, type=$2, balance=$3, icon=$4, color=$5 WHERE id=$6 AND user_id=$7',
            [
                name || existing[0].name,
                type || existing[0].type,
                balanceVal,
                icon || existing[0].icon,
                color || existing[0].color,
                req.params.id,
                req.userId
            ]);

        const { rows } = await pool.query('SELECT * FROM accounts WHERE id = $1', [req.params.id]);
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/accounts/:id
router.delete('/:id', async (req, res) => {
    try {
        const { rows: existing } = await pool.query('SELECT * FROM accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Account not found' });

        const { rows: txCount } = await pool.query(
            'SELECT COUNT(*) as count FROM transactions WHERE (account_id = $1 OR to_account_id = $1) AND user_id = $2',
            [req.params.id, req.userId]
        );

        if (parseInt(txCount[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete account with existing transactions. Delete transactions first.' });
        }

        await pool.query('DELETE FROM accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
