const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;

if (!connectionString) {
  throw new Error("Missing DATABASE_URL/POSTGRES_URL for Postgres connection");
}

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

async function query(text, params = []) {
  return pool.query(text, params);
}

const MIGRATIONS = [
  {
    id: "001_add_product_state_promotion",
    sql: `
      ALTER TABLE product_state
      ADD COLUMN IF NOT EXISTS promotion JSONB
    `,
  },
  {
    id: "002_min_check_interval_6_hours",
    sql: `
      ALTER TABLE user_settings
      ALTER COLUMN check_interval_minutes SET DEFAULT 360;

      UPDATE user_settings
      SET check_interval_minutes = 360,
          updated_at = NOW()
      WHERE check_interval_minutes < 360;
    `,
  },
];

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const migration of MIGRATIONS) {
      const { rows } = await client.query(
        `SELECT 1 FROM schema_migrations WHERE id = $1 LIMIT 1`,
        [migration.id]
      );
      if (rows.length) continue;

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [migration.id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      clerk_user_id TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id BIGINT PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
      check_interval_minutes INTEGER NOT NULL DEFAULT 360,
      telegram_bot_token TEXT,
      telegram_chat_id TEXT,
      last_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      slug_id TEXT NOT NULL,
      url TEXT NOT NULL,
      label TEXT NOT NULL,
      target_price DOUBLE PRECISION NOT NULL,
      price_type TEXT NOT NULL DEFAULT 'regular',
      currency TEXT NOT NULL DEFAULT 'EUR',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, slug_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS product_state (
      product_id BIGINT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
      last_price DOUBLE PRECISION,
      last_checked TIMESTAMPTZ,
      alert_sent BOOLEAN NOT NULL DEFAULT FALSE,
      promotion JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await runMigrations();
}

module.exports = { query, initSchema, pool };
