import express from 'express';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
router.use(authenticateToken);

// GET /api/stats/summary
router.get('/summary', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const now = new Date();
        const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

        const { rows: incomeRows } = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = $1 AND type = 'income' AND date >= $2 AND date <= $3`,
            [req.userId, start, end]
        );

        const { rows: expenseRows } = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = $1 AND type = 'expense' AND date >= $2 AND date <= $3`,
            [req.userId, start, end]
        );

        const income = parseFloat(incomeRows[0].total);
        const expense = parseFloat(expenseRows[0].total);
        const savings = income - expense;

        res.json({ income, expense, expenses: expense, balance: income - expense, savings, startDate: start, endDate: end });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/by-category
router.get('/by-category', async (req, res) => {
    try {
        const { startDate, endDate, type } = req.query;
        const now = new Date();
        const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        const txType = type || 'expense';

        const { rows } = await pool.query(
            `
       WITH category_totals AS (
         SELECT c.id,
                c.name,
                c.icon,
                c.color,
                COALESCE(SUM(t.amount), 0) AS total
         FROM categories c
         LEFT JOIN transactions t
           ON (t.category_id = c.id OR t.category_id IN (SELECT id FROM categories WHERE parent_id = c.id))
          AND t.date >= $1 AND t.date <= $2 AND t.type = $3
         WHERE c.user_id = $4 AND c.parent_id IS NULL AND c.type = $5
         GROUP BY c.id, c.name, c.icon, c.color
       ),
       uncategorized AS (
         SELECT NULL::text AS id,
                'Uncategorized'::text AS name,
                '📦'::text AS icon,
                '#AEB6BF'::text AS color,
                COALESCE(SUM(t.amount), 0) AS total
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = $4
           AND t.date >= $1 AND t.date <= $2
           AND t.type = $3
           AND (t.category_id IS NULL OR c.id IS NULL)
       )
       SELECT * FROM category_totals
       WHERE total > 0
       UNION ALL
       SELECT * FROM uncategorized WHERE total > 0
       ORDER BY total DESC
       `,
            [start, end, txType, req.userId, txType]
        );

        res.json(rows.map(r => ({ ...r, total: parseFloat(r.total) })));
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/by-subcategory — totals for children of a category (for Charts expand)
router.get('/by-subcategory', async (req, res) => {
    try {
        const { parentId, startDate, endDate } = req.query;
        if (!parentId) return res.status(400).json({ error: 'parentId required' });
        const now = new Date();
        const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

        const { rows } = await pool.query(
            `SELECT c.id, c.name, c.icon, c.color, COALESCE(SUM(t.amount), 0) AS total
             FROM categories c
             LEFT JOIN transactions t ON t.category_id = c.id AND t.date >= $1 AND t.date <= $2 AND t.type = 'expense'
             WHERE c.user_id = $3 AND c.parent_id = $4
             GROUP BY c.id, c.name, c.icon, c.color
             ORDER BY total DESC`,
            [start, end, req.userId, parentId]
        );
        res.json(rows.map(r => ({ ...r, total: parseFloat(r.total) })));
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/trend
router.get('/trend', async (req, res) => {
    try {
        const { startDate, endDate, groupBy } = req.query;
        const now = new Date();
        const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

        let dateFormat;
        if (groupBy === 'month') {
            dateFormat = "to_char(date::date, 'YYYY-MM')";
        } else if (groupBy === 'week') {
            dateFormat = "to_char(date::date, 'IYYY-\"W\"IW')";
        } else {
            dateFormat = 'date';
        }

        const { rows } = await pool.query(
            `SELECT ${dateFormat} as period, type,
       COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE user_id = $1 AND date >= $2 AND date <= $3
       GROUP BY period, type
       ORDER BY period`,
            [req.userId, start, end]
        );

        const grouped = {};
        rows.forEach(row => {
            if (!grouped[row.period]) {
                grouped[row.period] = { period: row.period, income: 0, expense: 0 };
            }
            grouped[row.period][row.type] = parseFloat(row.total);
        });

        res.json(Object.values(grouped));
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/trend-by-category — expense totals per period per main category (for stacked timeline)
router.get('/trend-by-category', async (req, res) => {
    try {
        const { startDate, endDate, groupBy } = req.query;
        const now = new Date();
        const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

        let dateFormat;
        if (groupBy === 'month') {
            dateFormat = "to_char(t.date::date, 'YYYY-MM')";
        } else if (groupBy === 'week') {
            dateFormat = "to_char(t.date::date, 'IYYY-\"W\"IW')";
        } else {
            dateFormat = 't.date::date';
        }

        const { rows } = await pool.query(
            `WITH main_cats AS (
               SELECT id, name, icon, color FROM categories
               WHERE user_id = $1 AND parent_id IS NULL AND type = 'expense'
             ),
             tx_with_cat AS (
               SELECT ${dateFormat} AS period,
                      COALESCE(m.id::text, 'uncategorized') AS cat_id,
                      COALESCE(m.name, 'Uncategorized') AS cat_name,
                      COALESCE(SUM(t.amount), 0) AS total
               FROM transactions t
               LEFT JOIN categories c ON t.category_id = c.id
               LEFT JOIN main_cats m ON (c.parent_id = m.id OR c.id = m.id)
               WHERE t.user_id = $1 AND t.type = 'expense' AND t.date >= $2 AND t.date <= $3
               GROUP BY period, m.id, m.name
             )
             SELECT period, cat_id, cat_name, total FROM tx_with_cat WHERE total > 0
             ORDER BY period, total DESC`,
            [req.userId, start, end]
        );

        const periodsMap = {};
        const categoriesMap = {};
        rows.forEach(row => {
            if (!periodsMap[row.period]) periodsMap[row.period] = { period: row.period };
            periodsMap[row.period][row.cat_id] = parseFloat(row.total);
            if (!categoriesMap[row.cat_id]) categoriesMap[row.cat_id] = { id: row.cat_id, name: row.cat_name };
        });
        const data = Object.values(periodsMap);
        const categories = Object.values(categoriesMap);
        res.json({ data, categories });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/insights — auto-computed insights for Dashboard (current vs previous month)
router.get('/insights', async (req, res) => {
    try {
        const now = new Date();
        const thisStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const thisEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
        const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

        const [curr, prev, topCat, dayRow] = await Promise.all([
            pool.query(`SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income, COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense FROM transactions WHERE user_id = $1 AND date >= $2 AND date <= $3`, [req.userId, thisStart, thisEnd]),
            pool.query(`SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income, COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense FROM transactions WHERE user_id = $1 AND date >= $2 AND date <= $3`, [req.userId, prevStart, prevEnd]),
            pool.query(`SELECT c.name, c.icon, COALESCE(SUM(t.amount), 0) as total FROM categories c LEFT JOIN transactions t ON (t.category_id = c.id OR t.category_id IN (SELECT id FROM categories WHERE parent_id = c.id)) AND t.date >= $1 AND t.date <= $2 AND t.type = 'expense' WHERE c.user_id = $3 AND c.parent_id IS NULL AND c.type = 'expense' GROUP BY c.id, c.name, c.icon ORDER BY total DESC LIMIT 1`, [thisStart, thisEnd, req.userId]),
            pool.query(`SELECT date, COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = $1 AND type = 'expense' AND date >= $2 AND date <= $3 GROUP BY date ORDER BY total DESC LIMIT 1`, [req.userId, thisStart, thisEnd]),
        ]);

        const currIncome = parseFloat(curr.rows[0]?.income || 0);
        const currExpense = parseFloat(curr.rows[0]?.expense || 0);
        const prevExpense = parseFloat(prev.rows[0]?.expense || 0);
        const prevIncome = parseFloat(prev.rows[0]?.income || 0);
        const savings = currIncome - currExpense;
        let expenseChange;
        if (prevExpense > 0) {
            expenseChange = ((currExpense - prevExpense) / prevExpense) * 100;
        } else if (currExpense > 0) {
            expenseChange = 100;
        } else {
            expenseChange = 0;
        }
        expenseChange = Math.max(-100, Math.min(300, Math.round(expenseChange)));
        const topCategory = topCat.rows[0];
        const topPct = currExpense > 0 && topCategory ? Math.round((parseFloat(topCategory.total) / currExpense) * 100) : 0;
        const highestDay = dayRow.rows[0];

        res.json({
            savings,
            expenseChange,
            topCategory: topCategory ? { name: topCategory.name, icon: topCategory.icon || '📦', pct: topPct } : null,
            highestSpendDay: highestDay ? { date: highestDay.date, amount: parseFloat(highestDay.total) } : null,
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/weekly-summary — income/expense/savings per week (last 4 weeks)
router.get('/weekly-summary', async (req, res) => {
    try {
        const now = new Date();
        const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 27); // last 4 weeks (~28 days)
        const start = startDate.toISOString().split('T')[0];
        const end = endDate.toISOString().split('T')[0];

        const { rows } = await pool.query(
            `SELECT to_char(date::date, 'IYYY-"W"IW') as week,
                    COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
                    COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
             FROM transactions
             WHERE user_id = $1
               AND date >= $2 AND date <= $3
             GROUP BY week
             ORDER BY week`,
            [req.userId, start, end]
        );

        const data = rows.map(r => {
            const income = parseFloat(r.income || 0);
            const expense = parseFloat(r.expense || 0);
            return {
                week: r.week,
                income,
                expense,
                savings: income - expense,
            };
        });

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/finly-score — simple financial health score 0–100
router.get('/finly-score', async (req, res) => {
    try {
        const now = new Date();
        const thisStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const thisEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
        const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

        const [curr, prev, budgets] = await Promise.all([
            pool.query(
                `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
                        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
                 FROM transactions
                 WHERE user_id = $1 AND date >= $2 AND date <= $3`,
                [req.userId, thisStart, thisEnd]
            ),
            pool.query(
                `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
                        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
                 FROM transactions
                 WHERE user_id = $1 AND date >= $2 AND date <= $3`,
                [req.userId, prevStart, prevEnd]
            ),
            // Simple budget adherence: monthly budgets and their spent amounts for this month
            pool.query(
                `SELECT b.id,
                        b.amount,
                        COALESCE(SUM(t.amount), 0) AS spent
                 FROM budgets b
                 LEFT JOIN transactions t
                   ON t.user_id = b.user_id
                  AND t.type = 'expense'
                  AND t.category_id = b.category_id
                  AND t.date >= $2 AND t.date <= $3
                 WHERE b.user_id = $1
                   AND b.period = 'monthly'
                 GROUP BY b.id, b.amount`,
                [req.userId, thisStart, thisEnd]
            ),
        ]);

        const currIncome = parseFloat(curr.rows[0]?.income || 0);
        const currExpense = parseFloat(curr.rows[0]?.expense || 0);
        const prevExpense = parseFloat(prev.rows[0]?.expense || 0);

        const savings = currIncome - currExpense;
        const savingsRate = currIncome > 0 ? Math.max(0, Math.min(1, savings / currIncome)) : 0;
        const savingsScore = Math.round(savingsRate * 100);

        let budgetAdherence = null;
        let budgetScore = null;
        if (budgets.rows.length > 0) {
            let ok = 0;
            budgets.rows.forEach(b => {
                const amount = parseFloat(b.amount || 0);
                const spent = parseFloat(b.spent || 0);
                if (amount > 0 && spent <= amount) ok += 1;
            });
            budgetAdherence = ok / budgets.rows.length;
            budgetScore = Math.round(budgetAdherence * 100);
        }

        let trendScore = 50;
        let expenseChange = null;
        if (prevExpense > 0) {
            expenseChange = ((currExpense - prevExpense) / prevExpense) * 100;
            if (expenseChange <= 0) {
                trendScore = 100;
            } else if (expenseChange >= 100) {
                trendScore = 0;
            } else {
                trendScore = Math.max(0, 100 - Math.round(expenseChange));
            }
        } else if (currExpense > 0) {
            expenseChange = 100;
            trendScore = 50;
        } else {
            expenseChange = 0;
            trendScore = 100;
        }

        const weightSavings = 0.4;
        const weightBudget = 0.4;
        const weightTrend = 0.2;

        const effectiveBudgetScore = budgetScore != null ? budgetScore : 70;
        const score =
            weightSavings * savingsScore +
            weightBudget * effectiveBudgetScore +
            weightTrend * trendScore;

        res.json({
            score: Math.round(Math.max(0, Math.min(100, score))),
            components: {
                savingsScore,
                savingsRate,
                budgetScore,
                budgetAdherence,
                trendScore,
                expenseChange: Math.round(expenseChange),
            },
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/forecast — month-end projections, budget risk, and goal pace
router.get('/forecast', async (req, res) => {
    try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        const today = now.toISOString().split('T')[0];
        const daysElapsed = Math.max(1, now.getDate());
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const paceMultiplier = daysInMonth / daysElapsed;

        const historicalStart = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString().split('T')[0];
        const historicalEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

        const [currentTotals, budgetRows, goalRows, historicalRows] = await Promise.all([
            pool.query(
                `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
                        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
                 FROM transactions
                 WHERE user_id = $1 AND date >= $2 AND date <= $3`,
                [req.userId, monthStart, today]
            ),
            pool.query(
                `SELECT b.category_id,
                        b.amount,
                        COALESCE(c.name, 'Category') AS category_name,
                        COALESCE(c.icon, '📦') AS category_icon,
                        COALESCE(SUM(t.amount), 0) AS spent
                 FROM budgets b
                 LEFT JOIN categories c
                   ON c.id = b.category_id
                 LEFT JOIN transactions t
                   ON t.user_id = b.user_id
                  AND t.type = 'expense'
                  AND t.category_id = b.category_id
                  AND t.date >= $2 AND t.date <= $3
                 WHERE b.user_id = $1
                   AND b.period = 'monthly'
                 GROUP BY b.category_id, b.amount, c.name, c.icon`,
                [req.userId, monthStart, today]
            ),
            pool.query(
                `SELECT id, name, target_amount, current_amount, month
                 FROM savings_goals
                 WHERE user_id = $1
                 ORDER BY created_at ASC`,
                [req.userId]
            ),
            pool.query(
                `SELECT to_char(date::date, 'YYYY-MM') as period,
                        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as income,
                        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as expense
                 FROM transactions
                 WHERE user_id = $1
                   AND date >= $2 AND date <= $3
                 GROUP BY period
                 ORDER BY period`,
                [req.userId, historicalStart, historicalEnd]
            ),
        ]);

        const currentIncome = parseFloat(currentTotals.rows[0]?.income || 0);
        const currentExpense = parseFloat(currentTotals.rows[0]?.expense || 0);
        const projectedIncome = currentIncome * paceMultiplier;
        const projectedExpense = currentExpense * paceMultiplier;
        const projectedBalance = projectedIncome - projectedExpense;

        const historicalSavings = historicalRows.rows.map((row) => {
            const income = parseFloat(row.income || 0);
            const expense = parseFloat(row.expense || 0);
            return income - expense;
        });
        const averageMonthlySavings = historicalSavings.length > 0
            ? historicalSavings.reduce((sum, value) => sum + value, 0) / historicalSavings.length
            : 0;

        const budgetRisks = budgetRows.rows
            .map((row) => {
                const budget = parseFloat(row.amount || 0);
                const spent = parseFloat(row.spent || 0);
                if (budget <= 0) return null;
                const projectedSpent = spent * paceMultiplier;
                const currentPct = (spent / budget) * 100;
                const projectedPct = (projectedSpent / budget) * 100;
                let riskLevel = 'on_track';
                if (projectedPct >= 100) riskLevel = 'overrun';
                else if (projectedPct >= 90 || currentPct >= 90) riskLevel = 'watch';
                return {
                    categoryId: row.category_id,
                    name: row.category_name,
                    icon: row.category_icon,
                    budget,
                    spent,
                    projectedSpent,
                    currentPct: Math.round(currentPct),
                    projectedPct: Math.round(projectedPct),
                    riskLevel,
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.projectedPct - a.projectedPct)
            .slice(0, 3);

        const incompleteGoals = goalRows.rows
            .map((row) => ({
                ...row,
                target_amount: parseFloat(row.target_amount || 0),
                current_amount: parseFloat(row.current_amount || 0),
            }))
            .filter((row) => row.target_amount > 0 && row.current_amount < row.target_amount)
            .sort((a, b) => ((b.current_amount / b.target_amount) || 0) - ((a.current_amount / a.target_amount) || 0));

        let goalForecast = null;
        if (incompleteGoals.length > 0) {
            const topGoal = incompleteGoals[0];
            const remainingAmount = Math.max(0, topGoal.target_amount - topGoal.current_amount);
            const monthlyContributionEstimate = projectedBalance > 0
                ? projectedBalance
                : averageMonthlySavings > 0
                    ? averageMonthlySavings
                    : 0;
            const etaMonths = monthlyContributionEstimate > 0
                ? Math.ceil(remainingAmount / monthlyContributionEstimate)
                : null;
            goalForecast = {
                id: topGoal.id,
                name: topGoal.name,
                targetAmount: topGoal.target_amount,
                currentAmount: topGoal.current_amount,
                remainingAmount,
                monthlyContributionEstimate,
                etaMonths,
                status: etaMonths === null
                    ? 'needs_attention'
                    : etaMonths <= 1
                        ? 'close'
                        : 'on_track',
            };
        }

        res.json({
            month: monthStart.slice(0, 7),
            startDate: monthStart,
            endDate: monthEnd,
            today,
            daysElapsed,
            daysInMonth,
            currentIncome,
            currentExpense,
            projectedIncome: Math.round(projectedIncome),
            projectedExpense: Math.round(projectedExpense),
            projectedBalance: Math.round(projectedBalance),
            averageMonthlySavings: Math.round(averageMonthlySavings),
            budgetRisks,
            goalForecast,
        });
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/stats/calendar/:year/:month
router.get('/calendar/:year/:month', async (req, res) => {
    try {
        const { year, month } = req.params;
        const startDate = `${year}-${month.padStart(2, '0')}-01`;
        const endDate = `${year}-${month.padStart(2, '0')}-31`;

        const { rows } = await pool.query(
            `SELECT date, type, COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE user_id = $1 AND date >= $2 AND date <= $3
       GROUP BY date, type
       ORDER BY date`,
            [req.userId, startDate, endDate]
        );

        const grouped = {};
        rows.forEach(row => {
            const day = parseInt(row.date.split('-')[2]);
            if (!grouped[day]) {
                grouped[day] = { day, income: 0, expense: 0 };
            }
            grouped[day][row.type] = parseFloat(row.total);
        });

        res.json(Object.values(grouped));
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
