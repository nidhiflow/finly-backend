import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

// GET /api/bookmarks - list all bookmarked transactions
router.get('/', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT b.id as bookmark_id, b.created_at as bookmarked_at,
                    t.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
                    a.name as account_name, a.icon as account_icon,
                    parent_acc.name as account_parent_name
             FROM bookmarks b
             JOIN transactions t ON b.transaction_id = t.id
             LEFT JOIN categories c ON t.category_id = c.id
             LEFT JOIN accounts a ON t.account_id = a.id
             LEFT JOIN accounts parent_acc ON a.parent_id = parent_acc.id
             WHERE b.user_id = $1
             ORDER BY b.created_at DESC`,
            [req.userId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Get bookmarks error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/bookmarks - bookmark a transaction
router.post('/', async (req, res) => {
    try {
        const { transaction_id } = req.body;
        if (!transaction_id) return res.status(400).json({ error: 'transaction_id is required' });

        const id = uuidv4();
        await pool.query(
            'INSERT INTO bookmarks (id, user_id, transaction_id) VALUES ($1, $2, $3) ON CONFLICT (user_id, transaction_id) DO NOTHING',
            [id, req.userId, transaction_id]
        );
        res.status(201).json({ id, transaction_id });
    } catch (err) {
        console.error('Create bookmark error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/bookmarks/:transactionId - remove bookmark
router.delete('/:transactionId', async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM bookmarks WHERE user_id = $1 AND transaction_id = $2',
            [req.userId, req.params.transactionId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Delete bookmark error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/bookmarks/check/:transactionId - check if bookmarked
router.get('/check/:transactionId', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id FROM bookmarks WHERE user_id = $1 AND transaction_id = $2',
            [req.userId, req.params.transactionId]
        );
        res.json({ bookmarked: rows.length > 0 });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/bookmarks/ids - get all bookmarked transaction IDs
router.get('/ids', async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT transaction_id FROM bookmarks WHERE user_id = $1',
            [req.userId]
        );
        res.json(rows.map(r => r.transaction_id));
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
