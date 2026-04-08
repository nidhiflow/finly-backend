import { pool } from './db.js';

async function migrate() {
    try {
        console.log("Adding columns to savings_goals...");
        await pool.query(`ALTER TABLE savings_goals 
            ADD COLUMN IF NOT EXISTS emoji VARCHAR(10) DEFAULT '🎯', 
            ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#7C5CFF', 
            ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active', 
            ADD COLUMN IF NOT EXISTS notes TEXT, 
            ADD COLUMN IF NOT EXISTS target_date DATE, 
            ADD COLUMN IF NOT EXISTS start_date DATE, 
            ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'one-time',
            ADD COLUMN IF NOT EXISTS carry_forward BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS tracking_mode VARCHAR(50) DEFAULT 'Manual'
        `);
        console.log("creating savings_goals_contributions...");
        await pool.query(`CREATE TABLE IF NOT EXISTS savings_goals_contributions (
            id UUID PRIMARY KEY,
            goal_id UUID REFERENCES savings_goals(id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            amount DECIMAL(12,2) NOT NULL,
            date DATE NOT NULL,
            note TEXT,
            from_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("Migration complete.");
    } catch(err) {
        console.error(err);
    } finally {
        pool.end();
    }
}
migrate();
