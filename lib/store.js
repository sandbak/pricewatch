const db = require("./db");

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function getOrCreateUser(clerkUserId) {
  const { rows } = await db.query(
    `
      INSERT INTO app_users (clerk_user_id)
      VALUES ($1)
      ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
      RETURNING id, clerk_user_id
    `,
    [clerkUserId]
  );

  await db.query(
    `
      INSERT INTO user_settings (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [rows[0].id]
  );

  return rows[0];
}

async function getSettings(userId) {
  const { rows } = await db.query(
    `SELECT check_interval_minutes, telegram_bot_token, telegram_chat_id, last_run_at FROM user_settings WHERE user_id = $1`,
    [userId]
  );
  return (
    rows[0] || {
      check_interval_minutes: 60,
      telegram_bot_token: null,
      telegram_chat_id: null,
      last_run_at: null,
    }
  );
}

async function updateSettings(userId, updates) {
  const interval =
    updates.checkIntervalMinutes != null
      ? Math.max(1, parseInt(updates.checkIntervalMinutes, 10) || 60)
      : null;
  const token = updates.botToken ?? null;
  const chatId = updates.chatId ?? null;

  await db.query(
    `
      UPDATE user_settings
      SET
        check_interval_minutes = COALESCE($2, check_interval_minutes),
        telegram_bot_token = COALESCE($3, telegram_bot_token),
        telegram_chat_id = COALESCE($4, telegram_chat_id),
        updated_at = NOW()
      WHERE user_id = $1
    `,
    [userId, interval, token || null, chatId || null]
  );

  return getSettings(userId);
}

async function touchUserRun(userId) {
  await db.query(`UPDATE user_settings SET last_run_at = NOW(), updated_at = NOW() WHERE user_id = $1`, [
    userId,
  ]);
}

async function generateUniqueSlug(userId, label) {
  const base = slugify(label) || "product";
  let candidate = base;
  let n = 2;

  while (true) {
    const { rows } = await db.query(`SELECT 1 FROM products WHERE user_id = $1 AND slug_id = $2 LIMIT 1`, [
      userId,
      candidate,
    ]);
    if (!rows.length) return candidate;
    candidate = `${base}-${n++}`;
  }
}

async function addProduct(userId, data) {
  let slugId = data.id ? slugify(data.id) : await generateUniqueSlug(userId, data.label);
  if (data.id) {
    const exists = await db.query(`SELECT 1 FROM products WHERE user_id = $1 AND slug_id = $2 LIMIT 1`, [
      userId,
      slugId,
    ]);
    if (exists.rows.length) {
      slugId = await generateUniqueSlug(userId, data.label);
    }
  }
  const { rows } = await db.query(
    `
      INSERT INTO products (user_id, slug_id, url, label, target_price, price_type, currency)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, slug_id AS id_slug, url, label, target_price, price_type, currency
    `,
    [
      userId,
      slugId,
      data.url,
      data.label,
      data.targetPrice,
      data.priceType || "regular",
      data.currency || "EUR",
    ]
  );
  return normalizeProduct(rows[0]);
}

async function updateProduct(userId, slugId, updates) {
  const fields = [];
  const params = [userId, slugId];
  let i = 3;

  if (updates.url != null) {
    fields.push(`url = $${i++}`);
    params.push(updates.url);
  }
  if (updates.label != null) {
    fields.push(`label = $${i++}`);
    params.push(updates.label);
  }
  if (updates.targetPrice != null) {
    fields.push(`target_price = $${i++}`);
    params.push(updates.targetPrice);
  }
  if (updates.priceType != null) {
    fields.push(`price_type = $${i++}`);
    params.push(updates.priceType);
  }
  if (updates.currency != null) {
    fields.push(`currency = $${i++}`);
    params.push(updates.currency);
  }

  if (!fields.length) {
    return getProductBySlug(userId, slugId);
  }

  fields.push(`updated_at = NOW()`);

  const { rows } = await db.query(
    `
      UPDATE products
      SET ${fields.join(", ")}
      WHERE user_id = $1 AND slug_id = $2
      RETURNING id, slug_id AS id_slug, url, label, target_price, price_type, currency
    `,
    params
  );

  return rows[0] ? normalizeProduct(rows[0]) : null;
}

async function deleteProduct(userId, slugId) {
  const { rowCount } = await db.query(`DELETE FROM products WHERE user_id = $1 AND slug_id = $2`, [
    userId,
    slugId,
  ]);
  return rowCount > 0;
}

async function getProductBySlug(userId, slugId) {
  const { rows } = await db.query(
    `
      SELECT p.id, p.slug_id AS id_slug, p.url, p.label, p.target_price, p.price_type, p.currency,
             s.last_price, s.last_checked, s.alert_sent, s.promotion
      FROM products p
      LEFT JOIN product_state s ON s.product_id = p.id
      WHERE p.user_id = $1 AND p.slug_id = $2
      LIMIT 1
    `,
    [userId, slugId]
  );
  return rows[0] ? normalizeProduct(rows[0]) : null;
}

async function listProducts(userId) {
  const { rows } = await db.query(
    `
      SELECT p.id, p.slug_id AS id_slug, p.url, p.label, p.target_price, p.price_type, p.currency,
             s.last_price, s.last_checked, s.alert_sent, s.promotion
      FROM products p
      LEFT JOIN product_state s ON s.product_id = p.id
      WHERE p.user_id = $1
      ORDER BY p.created_at ASC
    `,
    [userId]
  );
  return rows.map(normalizeProduct);
}

async function upsertProductState(productDbId, updates) {
  const hasPromotion = Object.prototype.hasOwnProperty.call(updates, "promotion");
  const hasAlertSent = Object.prototype.hasOwnProperty.call(updates, "alertSent");

  await db.query(
    `
      INSERT INTO product_state (product_id, last_price, last_checked, alert_sent, promotion, updated_at)
      VALUES ($1, $2, $3, COALESCE($4, false), $5::jsonb, NOW())
      ON CONFLICT (product_id)
      DO UPDATE SET
        last_price = COALESCE(EXCLUDED.last_price, product_state.last_price),
        last_checked = COALESCE(EXCLUDED.last_checked, product_state.last_checked),
        alert_sent = CASE WHEN $6 THEN EXCLUDED.alert_sent ELSE product_state.alert_sent END,
        promotion = CASE WHEN $7 THEN EXCLUDED.promotion ELSE product_state.promotion END,
        updated_at = NOW()
    `,
    [
      productDbId,
      updates.lastPrice ?? null,
      updates.lastChecked ?? null,
      hasAlertSent ? updates.alertSent : null,
      hasPromotion && updates.promotion ? JSON.stringify(updates.promotion) : null,
      hasAlertSent,
      hasPromotion,
    ]
  );
}

async function listUsersWithSettings() {
  const { rows } = await db.query(
    `
      SELECT u.id AS user_id, u.clerk_user_id,
             s.check_interval_minutes, s.telegram_bot_token, s.telegram_chat_id, s.last_run_at
      FROM app_users u
      JOIN user_settings s ON s.user_id = u.id
      ORDER BY u.id ASC
    `
  );
  return rows;
}

function normalizeProduct(row) {
  return {
    dbId: row.id,
    id: row.id_slug,
    url: row.url,
    label: row.label,
    targetPrice: row.target_price,
    priceType: row.price_type,
    currency: row.currency,
    lastPrice: row.last_price ?? null,
    lastChecked: row.last_checked ?? null,
    alertSent: row.alert_sent ?? false,
    promotion: row.promotion ?? null,
  };
}

module.exports = {
  getOrCreateUser,
  getSettings,
  updateSettings,
  touchUserRun,
  addProduct,
  updateProduct,
  deleteProduct,
  getProductBySlug,
  listProducts,
  upsertProductState,
  listUsersWithSettings,
};
