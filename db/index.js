const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize schema on first connect
async function initDB() {
  const fs = require('fs');
  const path = require('path');
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    // Split on semicolons and run each statement individually
    const statements = schema.split(';').map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      try {
        await pool.query(stmt);
      } catch (err) {
        console.error('DB statement error:', err.message);
        console.error('Statement was:', stmt.substring(0, 100));
      }
    }
    console.log('Database schema initialized (' + statements.length + ' statements)');
  } catch (err) {
    console.error('DB init error:', err.message);
  }
}

module.exports = { pool, initDB };
