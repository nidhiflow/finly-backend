import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const CHAT_RETENTION_DAYS = 7;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const CURRENCY_SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

async function getUserCurrency(userId) {
    try {
        const { rows } = await pool.query("SELECT value FROM settings WHERE user_id = $1 AND key = 'currency'", [userId]);
        const code = (rows[0]?.value || 'INR').toUpperCase();
        const symbol = CURRENCY_SYMBOLS[code] || code;
        const name = code === 'INR' ? 'Indian Rupee' : code === 'USD' ? 'US Dollar' : code === 'EUR' ? 'Euro' : code === 'GBP' ? 'British Pound' : code;
        return { code, symbol, name };
    } catch {
        return { code: 'INR', symbol: '₹', name: 'Indian Rupee' };
    }
}

// GET /api/ai/insights — AI coach style spending insights
router.get('/insights', authenticateToken, async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(503).json({ error: 'AI features are not configured. Set GROQ_API_KEY.' });
        }

        const today = new Date();
        const endDate = today.toISOString().split('T')[0];
        const start = new Date(today);
        start.setDate(start.getDate() - 60); // last ~2 months
        const startDate = start.toISOString().split('T')[0];

        // Basic totals by type over the recent window
        const { rows: typeRows } = await pool.query(
            `SELECT type, COALESCE(SUM(amount), 0) AS total
             FROM transactions
             WHERE user_id = $1 AND date >= $2 AND date <= $3
             GROUP BY type`,
            [req.userId, startDate, endDate]
        );

        // Monthly trend over the same window
        const { rows: monthRows } = await pool.query(
            `SELECT to_char(date::date, 'YYYY-MM') AS period,
                    type,
                    COALESCE(SUM(amount), 0) AS total
             FROM transactions
             WHERE user_id = $1 AND date >= $2 AND date <= $3
             GROUP BY period, type
             ORDER BY period`,
            [req.userId, startDate, endDate]
        );

        // Top categories by expense amount
        const { rows: categoryRows } = await pool.query(
            `SELECT COALESCE(c.name, 'Uncategorized') AS name,
                    COALESCE(c.type, 'expense') AS type,
                    COALESCE(SUM(t.amount), 0) AS total
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id
             WHERE t.user_id = $1
               AND t.date >= $2 AND t.date <= $3
               AND t.type = 'expense'
             GROUP BY COALESCE(c.name, 'Uncategorized'), COALESCE(c.type, 'expense')
             ORDER BY total DESC
             LIMIT 8`,
            [req.userId, startDate, endDate]
        );

        const summary = {
            window: { startDate, endDate },
            totalsByType: typeRows.map(r => ({ type: r.type, total: Number(r.total) })),
            trendByMonth: monthRows.map(r => ({ period: r.period, type: r.type, total: Number(r.total) })),
            topCategories: categoryRows.map(r => ({ name: r.name, type: r.type, total: Number(r.total) })),
        };

        const { symbol: currencySymbol, name: currencyName } = await getUserCurrency(req.userId);
        const systemPrompt = `You are Finly AI, a friendly personal finance coach for the Finly app.
The user's currency is ${currencyName} (symbol ${currencySymbol}). Always express all monetary amounts in this currency and use its symbol.
You receive structured JSON with the user's recent spending.

Your job is to:
- Focus on 3–5 of the most important CATEGORIES where the user is spending money (main or sub categories).
- For each key category, clearly mention its name and approximate spend, and then give 1–2 short, practical tips to reduce or control that spending.
- Use a warm, encouraging tone with emojis (for example 🎯, 💡, 📉, ☕) and very short sentences.
- Avoid long paragraphs. Prefer headings and bullet points that are easy to scan.

STRICT FORMAT:
- Start with a short heading like \"Key insights\".
- Then a bullet list of categories: \"• 🍔 Food – ₹X this month...\" with 1–2 sub‑bullets for tips.
- End with a tiny \"Next steps\" section suggesting 1–2 simple actions (set a budget, watch a category, check charts).

Do NOT output any JSON blocks. Answer only in concise markdown with emojis.`;

        const userPrompt = `Here is the user's recent spending data for about the last 2 months, as JSON:

${JSON.stringify(summary)}

Please write 2–3 key insights and 1–2 simple recommended next actions.`;

        const groqBody = {
            model: 'llama-3.1-8b-instant',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.7,
            max_tokens: 800
        };

        const groqResponse = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify(groqBody)
        });

        if (!groqResponse.ok) {
            const errText = await groqResponse.text();
            console.error('Groq insights error:', groqResponse.status, errText);
            let errorMsg = 'AI service error. Please try again.';
            try {
                const errData = JSON.parse(errText);
                if (errData?.error?.message) errorMsg = errData.error.message;
            } catch { }
            if (groqResponse.status === 401) errorMsg = 'Invalid Groq API key. Check GROQ_API_KEY in Render environment.';
            if (groqResponse.status === 429) errorMsg = 'AI rate limit reached. Please try again later.';
            return res.status(502).json({ error: errorMsg });
        }

        const data = await groqResponse.json();
        const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate insights right now.';

        res.json({ reply });
    } catch (err) {
        console.error('AI insights error:', err);
        res.status(500).json({ error: 'Failed to generate insights. Please try again.' });
    }
});

// GET /api/ai/chart-summary — AI summary for the current chart date range
router.get('/chart-summary', authenticateToken, async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(503).json({ error: 'AI features are not configured. Set GROQ_API_KEY.' });
        }

        const { startDate, endDate } = req.query;
        const now = new Date();
        const start = startDate || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const end = endDate || new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

        const { rows: typeRows } = await pool.query(
            `SELECT type, COALESCE(SUM(amount), 0) AS total
             FROM transactions
             WHERE user_id = $1 AND date >= $2 AND date <= $3
             GROUP BY type`,
            [req.userId, start, end]
        );

        const { rows: monthRows } = await pool.query(
            `SELECT to_char(date::date, 'YYYY-MM') AS period, type, COALESCE(SUM(amount), 0) AS total
             FROM transactions
             WHERE user_id = $1 AND date >= $2 AND date <= $3
             GROUP BY period, type
             ORDER BY period`,
            [req.userId, start, end]
        );

        const { rows: categoryRows } = await pool.query(
            `SELECT COALESCE(c.name, 'Uncategorized') AS name, COALESCE(SUM(t.amount), 0) AS total
             FROM transactions t
             LEFT JOIN categories c ON t.category_id = c.id
             WHERE t.user_id = $1 AND t.date >= $2 AND t.date <= $3 AND t.type = 'expense'
             GROUP BY COALESCE(c.name, 'Uncategorized')
             ORDER BY total DESC
             LIMIT 8`,
            [req.userId, start, end]
        );

        const summary = {
            window: { startDate: start, endDate: end },
            totalsByType: typeRows.map(r => ({ type: r.type, total: Number(r.total) })),
            trendByMonth: monthRows.map(r => ({ period: r.period, type: r.type, total: Number(r.total) })),
            topCategories: categoryRows.map(r => ({ name: r.name, total: Number(r.total) })),
        };

        const { symbol: currencySymbol, name: currencyName } = await getUserCurrency(req.userId);
        const systemPrompt = `You are Finly AI, a polished personal finance guide for the Finly app.
The user's currency is ${currencyName} (symbol ${currencySymbol}). Always express all monetary amounts in this currency and use its symbol.
You receive structured JSON with the user's money activity for a specific date range from the Reports page.

Write a short markdown summary using this exact structure:
**📌 Snapshot**
- one short bullet with the most important period takeaway
- one short bullet with a category, pace, or trend insight

**✅ Next step**
- one short bullet with a practical action

Rules:
- Keep it professional, warm, and easy to scan
- Use concrete numbers when helpful
- Use at most 3 bullets total
- Do NOT output JSON
- Do NOT mention internal tools, models, or providers`;

        const userPrompt = `Here is the user's money data for ${start} to ${end}:\n\n${JSON.stringify(summary)}\n\nWrite the report summary in the required format.`;

        const groqBody = {
            model: 'llama-3.1-8b-instant',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.7,
            max_tokens: 600
        };

        const groqResponse = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify(groqBody)
        });

        if (!groqResponse.ok) {
            const errText = await groqResponse.text();
            console.error('Groq chart-summary error:', groqResponse.status, errText);
            let errorMsg = 'AI service error. Please try again.';
            try {
                const errData = JSON.parse(errText);
                if (errData?.error?.message) errorMsg = errData.error.message;
            } catch { }
            if (groqResponse.status === 401) errorMsg = 'Invalid Groq API key. Check GROQ_API_KEY in Render environment.';
            if (groqResponse.status === 429) errorMsg = 'AI rate limit reached. Please try again later.';
            return res.status(502).json({ error: errorMsg });
        }

        const data = await groqResponse.json();
        const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a summary right now.';

        res.json({ reply });
    } catch (err) {
        console.error('AI chart-summary error:', err);
        res.status(500).json({ error: 'Failed to generate chart summary. Please try again.' });
    }
});

// GET /api/ai/budget-suggestions — AI-suggested budget amounts from recent spending
router.get('/budget-suggestions', authenticateToken, async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(503).json({ error: 'AI features are not configured. Set GROQ_API_KEY.' });
        }

        const monthParam = req.query.month;
        const now = new Date();
        const endDate = monthParam
            ? new Date(monthParam + '-01')
            : new Date(now.getFullYear(), now.getMonth(), 1);
        const startDate = new Date(endDate);
        startDate.setMonth(startDate.getMonth() - 3);
        const start = startDate.toISOString().split('T')[0];
        const end = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0).toISOString().split('T')[0];

        const { rows } = await pool.query(
            `SELECT parent.id AS category_id,
                    parent.name AS category_name,
                    COALESCE(SUM(t.amount), 0) AS total_spent
             FROM categories parent
             LEFT JOIN categories child
               ON child.user_id = parent.user_id
              AND child.type = 'expense'
              AND (child.id = parent.id OR child.parent_id = parent.id)
             LEFT JOIN transactions t
               ON t.category_id = child.id
              AND t.user_id = $1
              AND t.type = 'expense'
              AND t.date >= $2
              AND t.date <= $3
             WHERE parent.user_id = $1
               AND parent.type = 'expense'
               AND parent.parent_id IS NULL
             GROUP BY parent.id, parent.name
             ORDER BY total_spent DESC`,
            [req.userId, start, end]
        );

        const spending = rows.map(r => ({
            categoryId: r.category_id,
            categoryName: r.category_name,
            totalSpent: Number(r.total_spent),
        }));

        if (spending.length === 0) {
            return res.json({ suggestions: [] });
        }

        const { symbol: currencySymbol, name: currencyName } = await getUserCurrency(req.userId);
        const systemPrompt = `You are Finly AI, a budget assistant. The user's currency is ${currencyName} (symbol ${currencySymbol}). Always express amounts in this currency.
You receive an array of expense categories with their total spending over the last few months.
Your task: suggest a reasonable MONTHLY budget amount for each category. Return ONLY a valid JSON array, no other text.
Each item must have: "categoryId" (string, same as input), "categoryName" (string), "suggestedAmount" (number), "reason" (short string, e.g. "Based on recent spending").
Be practical: suggest slightly above average spending to allow flexibility. Round to sensible numbers (e.g. 5000 not 4832).`;

        const userPrompt = `Spending by category (last ~3 months):\n${JSON.stringify(spending)}\n\nSuggest monthly budget amounts. Return JSON array with categoryId, categoryName, suggestedAmount, reason.`;

        const groqBody = {
            model: 'llama-3.1-8b-instant',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 1024,
        };

        const MAX_ATTEMPTS = 2;
        let suggestions = [];
        let lastError = '';

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const groqResponse = await fetch(GROQ_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`,
                },
                body: JSON.stringify(groqBody),
            });

            if (!groqResponse.ok) {
                const errText = await groqResponse.text();
                console.error('Groq budget-suggestions error:', groqResponse.status, errText);
                lastError = 'AI service error. Please try again.';
                try {
                    const errData = JSON.parse(errText);
                    if (errData?.error?.message) lastError = errData.error.message;
                } catch { }
                if (groqResponse.status === 401) lastError = 'Invalid Groq API key. Check GROQ_API_KEY in Render environment.';
                if (groqResponse.status === 429) {
                    lastError = 'AI rate limit reached. Please try again later.';
                    if (attempt < MAX_ATTEMPTS - 1) {
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                }
                if (attempt === MAX_ATTEMPTS - 1) {
                    return res.status(502).json({ error: lastError });
                }
                continue;
            }

            const data = await groqResponse.json();
            const text = data.choices?.[0]?.message?.content || '';
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        suggestions = parsed;
                        break;
                    }
                } catch { /* retry */ }
            }
            lastError = 'AI returned an invalid response. Retrying...';
        }

        if (!Array.isArray(suggestions) || suggestions.length === 0) {
            return res.status(502).json({ error: lastError || 'AI could not generate budget suggestions. Please try again.' });
        }
        res.json({ suggestions });
    } catch (err) {
        console.error('AI budget-suggestions error:', err);
        res.status(500).json({ error: 'Failed to generate budget suggestions. Please try again.' });
    }
});

// POST /api/ai/scan-receipt — Scan a receipt image and extract transaction details
router.post('/scan-receipt', authenticateToken, async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(503).json({ error: 'AI features are not configured. Set GROQ_API_KEY.' });
        }

        const { image } = req.body; // base64 image data
        if (!image) {
            return res.status(400).json({ error: 'No image provided' });
        }

        // Validate / normalize image data
        if (image.startsWith('data:') && !image.startsWith('data:image/')) {
            return res.status(400).json({ error: 'Invalid image data' });
        }
        const dataUrl = image.startsWith('data:')
            ? image
            : `data:image/jpeg;base64,${image}`;

        const scanPrompt = `Analyze this receipt or bill image.

If the receipt has multiple line items, categories, or groups (e.g. Veggies, Snacks, Beverages, Delivery, GST, Service Charge, Delivery Fee), you MUST return an "entries" array.

For itemized bills (Swiggy, Zomato, Zepto, grocery bills, etc.), return one entry per category or group (e.g. Veggies, Snacks, Beverages, Delivery, Other/Tax). Use short "category_suggestion" labels that match the receipt. The sum of ALL entry amounts MUST equal the TRUE grand total paid, including GST, service charges, and delivery fees.

When the receipt HAS a line-item or category-wise breakdown, return a JSON object with:
- "entries": array of objects, each with:
  - "amount" (number)
  - "category_suggestion" (string). Use labels like: "Fruits", "Vegetables", "Grocery", "Veggies", "Snacks", "Beverages", "Dairy", "Meat", "Delivery", "Tax", "Other".
- Optionally "amount": number — the SAME GRAND TOTAL paid (including all taxes, GST, service charges, delivery fees, etc.).
  - IMPORTANT: If you include "amount" together with "entries", then:
    - "amount" MUST be exactly equal to the sum of all "entries[i].amount" (within normal rounding).
    - NEVER set "amount" to the sum of entries PLUS any extra value.
    - NEVER double or multiply totals. Do not return 2x or 3x the grand total.
- "note": string (merchant/store name)
- "date": string (YYYY-MM-DD or null)
- "type": "expense"

Use the single-total format ONLY when the receipt shows a single amount with no line items and no category breakdown. In that case return:
- "amount": number (total paid)
- "note": string (merchant/store name)
- "date": string (YYYY-MM-DD or null)
- "category_suggestion": string (one of: Food, Home Provisions, Entertainment, Health, Household, Travel, Vehicle, Other)
- "type": "expense" or "income"

Return ONLY valid JSON, no other text.`;

        const groqBody = {
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: scanPrompt },
                        { type: 'image_url', image_url: { url: dataUrl } }
                    ]
                }
            ],
            temperature: 0.1,
            max_tokens: 800
        };

        const groqResponse = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify(groqBody)
        });

        if (!groqResponse.ok) {
            const errText = await groqResponse.text();
            console.error('Groq scan error:', groqResponse.status, errText);
            return res.status(502).json({ error: 'AI service error. Please try again.' });
        }

        const groqData = await groqResponse.json();
        const text = groqData.choices?.[0]?.message?.content || '';

        // Extract JSON from the response
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return res.status(422).json({ error: 'Could not extract transaction details from the image.' });
        }

        const extracted = JSON.parse(jsonMatch[0]);

        // Normalize: when entries exist, also expose a grand total amount
        if (extracted.entries && Array.isArray(extracted.entries)) {
            if (extracted.entries.length > 1) {
                const totalFromEntries = extracted.entries.reduce((sum, e) => {
                    const raw = typeof e.amount === 'number' ? e.amount : parseFloat(e.amount);
                    const num = Number.isFinite(raw) ? raw : 0;
                    return sum + num;
                }, 0);
                let amount = Number.isFinite(extracted.amount) ? extracted.amount : totalFromEntries;

                // Defensive correction: if the model returned an amount that
                // is clearly different from the sum of entries (for example 2x),
                // prefer the sum of entries as the true grand total.
                if (Number.isFinite(amount) && totalFromEntries > 0) {
                    const ratio = amount / totalFromEntries;
                    if (ratio > 1.25 || ratio < 0.75) {
                        amount = totalFromEntries;
                    }
                }

                return res.json({
                    amount,
                    entries: extracted.entries,
                    note: extracted.note || '',
                    date: extracted.date || null,
                    type: extracted.type || 'expense'
                });
            }
            if (extracted.entries.length === 1) {
                const e = extracted.entries[0];
                return res.json({
                    amount: typeof extracted.amount === 'number' ? extracted.amount : e.amount,
                    note: extracted.note || '',
                    date: extracted.date || null,
                    category_suggestion: e.category_suggestion || null,
                    type: extracted.type || 'expense'
                });
            }
        }

        res.json(extracted);
    } catch (err) {
        console.error('Receipt scan error:', err);
        res.status(500).json({ error: 'Failed to scan receipt. Please try again.' });
    }
});

// POST /api/ai/chat — AI Agent chat
router.post('/chat', authenticateToken, async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(503).json({ error: 'AI features are not configured. Set GROQ_API_KEY.' });
        }

        const { message } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'No message provided' });
        }

        // Fetch user's categories (main + sub) and accounts for add-transaction intent
        let categoriesList = [];
        let accountsList = [];
        try {
            const catRes = await pool.query(
                'SELECT id, name, type, parent_id FROM categories WHERE user_id = $1 ORDER BY parent_id NULLS FIRST, name',
                [req.userId]
            );
            categoriesList = catRes.rows.map(r => ({ id: r.id, name: r.name, type: r.type }));
        } catch (e) {
            console.warn('AI chat: could not fetch categories', e.message);
        }
        try {
            const accRes = await pool.query(
                'SELECT id, name FROM accounts WHERE user_id = $1 AND parent_id IS NULL ORDER BY name',
                [req.userId]
            );
            accountsList = accRes.rows.map(r => ({ id: r.id, name: r.name }));
        } catch (e) {
            try {
                const accRes = await pool.query('SELECT id, name FROM accounts WHERE user_id = $1 ORDER BY name', [req.userId]);
                accountsList = accRes.rows.map(r => ({ id: r.id, name: r.name }));
            } catch (e2) {
                console.warn('AI chat: could not fetch accounts', e2.message);
            }
        }

        // Limit how many categories/accounts we embed to keep prompts small
        const LIMITED_CATEGORIES = categoriesList.slice(0, 60);
        const LIMITED_ACCOUNTS = accountsList.slice(0, 20);

        const { symbol: currencySymbol, name: currencyName } = await getUserCurrency(req.userId);
        const todayStr = new Date().toISOString().split('T')[0];
        const systemPrompt = `You are Finly AI, the in-app assistant for the Finly personal finance tracker.
The user's currency is ${currencyName} (symbol ${currencySymbol}). Always express all monetary amounts in this currency and use its symbol (e.g. ${currencySymbol} for amounts).

Finly lets users track income and expenses, view dashboards and charts, manage accounts and categories, set budgets, and configure settings.

CRITICAL: You must ONLY answer questions about the Finly app and personal finance tracking within Finly. For ANY question unrelated to Finly (general knowledge, world events, other apps, open-ended topics, etc.), do NOT answer it. Instead, politely say: "I'm here to help with Finly only — your personal finance tracker. I can help you with transactions, budgets, charts, accounts, categories, and more. What would you like to know about Finly?" Keep responses focused on Finly features and usage.

Guidelines:
- Be concise, friendly, and helpful — but only about Finly
- When explaining how to do something in the app, give step-by-step instructions
- Use emoji sparingly for a friendly tone
- Format responses with markdown for readability

When the user clearly wants to ADD or RECORD a transaction (expense or income), you must:
1. Reply with a short friendly confirmation (e.g. "I'll open the Add Transaction form for you to confirm.")
2. In addition, output a single JSON block on its own line, enclosed in \`\`\`json and \`\`\`, with this exact structure. Use ONLY the following category and account IDs (match by name; if unsure use the first matching name or omit the field):
\`\`\`json
{"action":"add_transaction","prefill":{"type":"expense|income","amount":<number>,"category_id":"<id from list>","account_id":"<id from list>","date":"YYYY-MM-DD","note":"<short note or empty string>"}}
\`\`\`
Today's date is ${todayStr}. Use it for "today". For date use YYYY-MM-DD only.
Categories (id, name, type): ${JSON.stringify(LIMITED_CATEGORIES)}
Accounts (id, name): ${JSON.stringify(LIMITED_ACCOUNTS)}
If the user did NOT ask to add a transaction, do not include any \`\`\`json block.`;

        const groqMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
        ];

        const groqBody = {
            model: 'llama-3.1-8b-instant',
            messages: groqMessages,
            temperature: 0.7,
            max_tokens: 1000
        };

        const fetchOptions = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify(groqBody)
        };

        let groqResponse = await fetch(GROQ_URL, fetchOptions);

        // 429 (rate limit): short, single retry to favour speed over long waits
        if (!groqResponse.ok && groqResponse.status === 429) {
            await new Promise(r => setTimeout(r, 2000));
            groqResponse = await fetch(GROQ_URL, fetchOptions);
        }
        // Simple retry for transient server errors
        if (!groqResponse.ok && [500, 502, 503].includes(groqResponse.status)) {
            groqResponse = await fetch(GROQ_URL, fetchOptions);
        }

        if (!groqResponse.ok) {
            const errText = await groqResponse.text();
            console.error('Groq chat error:', groqResponse.status, errText);
            let errorMsg = 'AI service error. Please try again.';
            try {
                const errData = JSON.parse(errText);
                if (errData?.error?.message) errorMsg = errData.error.message;
            } catch { }
            if (groqResponse.status === 401) {
                errorMsg = 'Invalid Groq API key. Check GROQ_API_KEY in Render environment.';
            } else if (groqResponse.status === 429) {
                errorMsg = 'AI rate limit reached. Please try again later.';
            }
            return res.status(502).json({ error: errorMsg });
        }

        const data = await groqResponse.json();
        let reply = data.choices?.[0]?.message?.content || 'Sorry, I couldn\'t generate a response. Please try again.';

        // Parse optional add_transaction JSON block from reply
        let addTransactionPrefill = null;
        const jsonBlockMatch = reply.match(/```json\s*([\s\S]*?)```/);
        if (jsonBlockMatch) {
            try {
                const parsed = JSON.parse(jsonBlockMatch[1].trim());
                if (parsed.action === 'add_transaction' && parsed.prefill && typeof parsed.prefill === 'object') {
                    const p = parsed.prefill;
                    if (p.type && (p.amount !== undefined && p.amount !== null) && p.account_id && p.date) {
                        addTransactionPrefill = {
                            type: p.type,
                            amount: Number(p.amount),
                            account_id: p.account_id,
                            date: p.date,
                            category_id: p.category_id || undefined,
                            note: p.note || undefined
                        };
                    }
                }
            } catch (e) {
                console.warn('AI chat: could not parse add_transaction block', e.message);
            }
            reply = reply.replace(/```json\s*[\s\S]*?```/g, '').trim();
        }

        // Persist user message and assistant reply (keep last 7 days)
        try {
            await pool.query(
                'INSERT INTO ai_chat_messages (id, user_id, role, content) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
                [uuidv4(), req.userId, 'user', message, uuidv4(), req.userId, 'assistant', reply]
            );
            await pool.query(
                'DELETE FROM ai_chat_messages WHERE user_id = $1 AND created_at < NOW() - INTERVAL \'1 day\' * $2',
                [req.userId, CHAT_RETENTION_DAYS]
            );
        } catch (e) {
            console.warn('AI chat persist:', e.message);
        }

        const payload = { reply };
        if (addTransactionPrefill) payload.addTransactionPrefill = addTransactionPrefill;
        res.json(payload);
    } catch (err) {
        console.error('AI chat error:', err.message || err);
        res.status(500).json({ error: 'Failed to get AI response. Please try again.' });
    }
});

// GET /api/ai/chat-history — last 7 days
router.get('/chat-history', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT role, content FROM ai_chat_messages WHERE user_id = $1 AND created_at >= NOW() - INTERVAL \'7 days\' ORDER BY created_at ASC',
            [req.userId]
        );
        const messages = rows.map(r => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }));
        res.json({ messages });
    } catch (err) {
        console.error('Chat history error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/ai/clear-chat — delete all chat messages for current user
router.post('/clear-chat', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM ai_chat_messages WHERE user_id = $1', [req.userId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Clear chat error:', err);
        res.status(500).json({ error: 'Failed to clear chat. Please try again.' });
    }
});

export default router;
