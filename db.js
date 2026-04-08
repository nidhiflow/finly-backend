import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { defaultExpenseCategories, defaultIncomeCategories } from './defaultCategories.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Initialize schema
async function initDB() {
  await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            email_verified BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            parent_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            balance NUMERIC DEFAULT 0,
            icon TEXT,
            color TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            icon TEXT,
            color TEXT,
            parent_id TEXT REFERENCES categories(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type TEXT NOT NULL,
            amount NUMERIC NOT NULL,
            category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
            account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            to_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            date TEXT NOT NULL,
            note TEXT,
            photo TEXT,
            repeat_group_id TEXT,
            repeat_end_date TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS budgets (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
            amount NUMERIC NOT NULL,
            period TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS savings_goals (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            target_amount NUMERIC NOT NULL,
            current_amount NUMERIC DEFAULT 0,
            month TEXT, -- optional YYYY-MM for monthly goals
            emoji TEXT DEFAULT '🎯',
            color TEXT DEFAULT '#7C5CFF',
            status TEXT DEFAULT 'active',
            notes TEXT,
            target_date TEXT,
            start_date TEXT,
            type TEXT DEFAULT 'one-time',
            tracking_mode TEXT DEFAULT 'Manual',
            carry_forward BOOLEAN DEFAULT false,
            linked_account TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS savings_goals_contributions (
            id TEXT PRIMARY KEY,
            goal_id TEXT REFERENCES savings_goals(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            amount NUMERIC NOT NULL,
            date TEXT NOT NULL,
            note TEXT,
            from_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS settings (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT,
            PRIMARY KEY (user_id, key)
        );

        CREATE TABLE IF NOT EXISTS otp_codes (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            code TEXT NOT NULL,
            type TEXT NOT NULL,
            name TEXT,
            password TEXT,
            expires_at TIMESTAMP NOT NULL,
            used BOOLEAN DEFAULT false,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS login_devices (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            device_hash TEXT NOT NULL,
            device_info TEXT NOT NULL,
            ip_address TEXT,
            first_seen TIMESTAMP DEFAULT NOW(),
            last_seen TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, device_hash)
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, transaction_id)
        );
    `);

  // Migration: add repeat columns to transactions if missing (existing DBs)
  try {
    const { rows: cols } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'repeat_group_id'");
    if (cols.length === 0) {
      await pool.query('ALTER TABLE transactions ADD COLUMN repeat_group_id TEXT');
      await pool.query('ALTER TABLE transactions ADD COLUMN repeat_end_date TEXT');
      console.log('✅ Migrated transactions table (repeat columns)');
    }
  } catch (e) {
    console.warn('Migration skip or error:', e.message);
  }

  // Migration: add parent_id to accounts if missing (existing DBs)
  try {
    const { rows: accCols } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'parent_id'");
    if (accCols.length === 0) {
      await pool.query('ALTER TABLE accounts ADD COLUMN parent_id TEXT REFERENCES accounts(id) ON DELETE CASCADE');
      console.log('✅ Migrated accounts table (parent_id)');
    }
  } catch (e) {
    console.warn('Accounts migration skip or error:', e.message);
  }

  // Migration: add category_id and account_id to savings_goals if missing (existing DBs)
  try {
    const { rows: sgCols } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'savings_goals' AND column_name = 'category_id'");
    if (sgCols.length === 0) {
      await pool.query('ALTER TABLE savings_goals ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE savings_goals ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL');
      console.log('✅ Migrated savings_goals table (category_id, account_id)');
    }
  } catch (e) {
    console.warn('Savings goals migration skip or error:', e.message);
  }

  // Migration: add extended fields to savings_goals if missing (existing DBs)
  try {
    const { rows: sgColsExtended } = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'savings_goals' AND column_name = 'emoji'");
    if (sgColsExtended.length === 0) {
      await pool.query("ALTER TABLE savings_goals ADD COLUMN emoji TEXT DEFAULT '🎯'");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN color TEXT DEFAULT '#7C5CFF'");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN status TEXT DEFAULT 'active'");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN notes TEXT");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN target_date TEXT");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN start_date TEXT");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN type TEXT DEFAULT 'one-time'");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN tracking_mode TEXT DEFAULT 'Manual'");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN carry_forward BOOLEAN DEFAULT false");
      await pool.query("ALTER TABLE savings_goals ADD COLUMN linked_account TEXT");
      console.log('✅ Migrated savings_goals table (extended fields)');
    }
  } catch (e) {
    console.warn('Savings goals extended migration skip or error:', e.message);
  }

  console.log('✅ Database schema initialized');
}

// Seed default data for a new user
async function seedDefaultsForUser(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const cat of defaultExpenseCategories) {
      const catId = uuidv4();
      await client.query(
        'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [catId, userId, cat.name, 'expense', cat.icon, cat.color, null]
      );
      for (const sub of cat.subs) {
        await client.query(
          'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [uuidv4(), userId, sub, 'expense', cat.icon, cat.color, catId]
        );
      }
    }

    for (const cat of defaultIncomeCategories) {
      const catId = uuidv4();
      await client.query(
        'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [catId, userId, cat.name, 'income', cat.icon, cat.color, null]
      );
      for (const sub of cat.subs) {
        await client.query(
          'INSERT INTO categories (id, user_id, name, type, icon, color, parent_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [uuidv4(), userId, sub, 'income', cat.icon, cat.color, catId]
        );
      }
    }

    // Default accounts
    await client.query(
      'INSERT INTO accounts (id, user_id, name, type, balance, icon, color) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [uuidv4(), userId, 'Cash', 'cash', 0, '💵', '#2ECC71']
    );
    await client.query(
      'INSERT INTO accounts (id, user_id, name, type, balance, icon, color) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [uuidv4(), userId, 'Bank Account', 'bank', 0, '🏦', '#3498DB']
    );
    await client.query(
      'INSERT INTO accounts (id, user_id, name, type, balance, icon, color) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [uuidv4(), userId, 'Credit Card', 'credit_card', 0, '💳', '#E74C3C']
    );

    // Default settings
    await client.query('INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)', [userId, 'currency', 'INR']);
    await client.query('INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)', [userId, 'currencySymbol', '₹']);
    await client.query('INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)', [userId, 'startDayOfWeek', '1']);
    await client.query('INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)', [userId, 'theme', 'dark']);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { pool, initDB, seedDefaultsForUser };
