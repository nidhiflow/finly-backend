import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { defaultExpenseCategories, defaultIncomeCategories } from '../defaultCategories.js';

const router = express.Router();
router.use(authenticateToken);

// GET /api/categories
router.get('/', async (req, res) => {
    try {
        const { rows: categories } = await pool.query(
            'SELECT * FROM categories WHERE user_id = $1 AND parent_id IS NULL ORDER BY name', [req.userId]
        );

        const withSubs = await Promise.all(categories.map(async cat => {
            const { rows: subs } = await pool.query(
                'SELECT * FROM categories WHERE parent_id = $1 AND user_id = $2 ORDER BY name', [cat.id, req.userId]
            );
            return { ...cat, subcategories: subs };
        }));

        res.json(withSubs);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/categories
router.post('/', async (req, res) => {
    try {
        const { name, type, icon, color, parent_id } = req.body;
        if (!name || !type) return res.status(400).json({ error: 'Name and type are required' });

        const id = uuidv4();
        await pool.query(
            'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, req.userId, name, type, icon || '📁', color || '#AEB6BF', parent_id || null]
        );

        const { rows } = await pool.query('SELECT * FROM categories WHERE id = $1', [id]);
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT /api/categories/:id
router.put('/:id', async (req, res) => {
    try {
        const { rows: existing } = await pool.query('SELECT * FROM categories WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Category not found' });

        const { name, icon, color } = req.body;
        await pool.query('UPDATE categories SET name=$1, icon=$2, color=$3 WHERE id=$4 AND user_id=$5',
            [name || existing[0].name, icon || existing[0].icon, color || existing[0].color, req.params.id, req.userId]);

        const { rows } = await pool.query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE /api/categories/:id
router.delete('/:id', async (req, res) => {
    try {
        const { rows: existing } = await pool.query('SELECT * FROM categories WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
        if (existing.length === 0) return res.status(404).json({ error: 'Category not found' });

        await pool.query('DELETE FROM categories WHERE parent_id = $1 AND user_id = $2', [req.params.id, req.userId]);
        await pool.query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/categories/sync-defaults — reset to canonical defaults for existing users
router.post('/sync-defaults', async (req, res) => {
    try {
        // Old default main category names that we no longer want to keep
        // (we will delete these and their subcategories, but leave any custom
        // categories that users created with other names).
        const oldExpenseDefaultNames = [
            'Food & Dining',
            'Transport',
            'Shopping',
            'Bills & Utilities',
            'Education',
            'Housing',
            'Other',
        ];
        const oldIncomeDefaultNames = [
            'Freelance',
            'Investments',
            'Gifts',
            'Other Income',
        ];

        let added = 0;
        let removed = 0;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // 1) Remove old default main categories we no longer support, along with their subcategories
            for (const name of oldExpenseDefaultNames) {
                const { rows: toDel } = await client.query(
                    'SELECT id FROM categories WHERE user_id = $1 AND type = $2 AND name = $3 AND parent_id IS NULL',
                    [req.userId, 'expense', name]
                );
                for (const row of toDel) {
                    await client.query('DELETE FROM categories WHERE parent_id = $1 AND user_id = $2', [row.id, req.userId]);
                    await client.query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [row.id, req.userId]);
                    removed++;
                }
            }
            for (const name of oldIncomeDefaultNames) {
                const { rows: toDel } = await client.query(
                    'SELECT id FROM categories WHERE user_id = $1 AND type = $2 AND name = $3 AND parent_id IS NULL',
                    [req.userId, 'income', name]
                );
                for (const row of toDel) {
                    await client.query('DELETE FROM categories WHERE parent_id = $1 AND user_id = $2', [row.id, req.userId]);
                    await client.query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [row.id, req.userId]);
                    removed++;
                }
            }

            // 1b) Clean up legacy subcategories that should no longer exist under specific mains
            const legacySubcategoryCleanup = [
                {
                    mainName: 'Entertainment',
                    type: 'expense',
                    subs: ['Events', 'Games', 'Movies', 'Subscriptions'],
                },
                {
                    mainName: 'Health',
                    type: 'expense',
                    subs: ['Insurance', 'Medicine', 'Doctor'],
                },
                {
                    mainName: 'Travel',
                    type: 'expense',
                    subs: ['Hotels', 'Activitie', 'Activities', 'Flights'],
                },
            ];

            for (const cfg of legacySubcategoryCleanup) {
                const { rows: mains } = await client.query(
                    'SELECT id FROM categories WHERE user_id = $1 AND type = $2 AND name = $3 AND parent_id IS NULL',
                    [req.userId, cfg.type, cfg.mainName]
                );
                for (const main of mains) {
                    const { rowCount } = await client.query(
                        'DELETE FROM categories WHERE user_id = $1 AND type = $2 AND parent_id = $3 AND name = ANY($4::text[])',
                        [req.userId, cfg.type, main.id, cfg.subs]
                    );
                    removed += rowCount;
                }
            }

            // 2) Ensure all default expense categories and their subcategories exist (add only missing)
            for (const cat of defaultExpenseCategories) {
                // Find or create main category
                let mainId;
                const { rows: existingMain } = await client.query(
                    'SELECT id FROM categories WHERE user_id = $1 AND type = $2 AND name = $3 AND parent_id IS NULL',
                    [req.userId, 'expense', cat.name]
                );
                if (existingMain.length === 0) {
                    mainId = uuidv4();
                    await client.query(
                        'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                        [mainId, req.userId, cat.name, 'expense', cat.icon, cat.color, null]
                    );
                    added++;
                } else {
                    mainId = existingMain[0].id;
                }

                // Fetch existing subcategory names for this main
                const { rows: existingSubs } = await client.query(
                    'SELECT name FROM categories WHERE user_id = $1 AND parent_id = $2',
                    [req.userId, mainId]
                );
                const existingSubNames = new Set(existingSubs.map(s => s.name));

                for (const sub of cat.subs) {
                    if (!existingSubNames.has(sub)) {
                        await client.query(
                            'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                            [uuidv4(), req.userId, sub, 'expense', cat.icon, cat.color, mainId]
                        );
                        added++;
                    }
                }
            }

            // 3) Ensure all default income categories and their subcategories exist (add only missing)
            for (const cat of defaultIncomeCategories) {
                let mainId;
                const { rows: existingMain } = await client.query(
                    'SELECT id FROM categories WHERE user_id = $1 AND type = $2 AND name = $3 AND parent_id IS NULL',
                    [req.userId, 'income', cat.name]
                );
                if (existingMain.length === 0) {
                    mainId = uuidv4();
                    await client.query(
                        'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                        [mainId, req.userId, cat.name, 'income', cat.icon, cat.color, null]
                    );
                    added++;
                } else {
                    mainId = existingMain[0].id;
                }

                const { rows: existingSubs } = await client.query(
                    'SELECT name FROM categories WHERE user_id = $1 AND parent_id = $2',
                    [req.userId, mainId]
                );
                const existingSubNames = new Set(existingSubs.map(s => s.name));

                for (const sub of cat.subs) {
                    if (!existingSubNames.has(sub)) {
                        await client.query(
                            'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                            [uuidv4(), req.userId, sub, 'income', cat.icon, cat.color, mainId]
                        );
                        added++;
                    }
                }
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }

        res.json({ success: true, added, removed });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
