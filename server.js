require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

// Serve the compliance checker app
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/documents', require('./routes/documents'));
app.use('/api/analysis', require('./routes/analysis'));
app.use('/api/report', require('./routes/report'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/migrate', require('./routes/migrate'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'TCC Compliance Checker', version: '2.0.0' });
});

// Manual DB init (one-time use)
app.post('/api/init-db', async (req, res) => {
  try {
    await initDB();
    const { pool } = require('./db');
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    res.json({ success: true, tables: tables.rows.map(r => r.tablename) });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// DB debug - check connection and tables
app.get('/api/db-status', async (req, res) => {
  try {
    const { pool } = require('./db');
    const tables = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    const dbUrl = process.env.DATABASE_URL ? 'Set (' + process.env.DATABASE_URL.substring(0, 30) + '...)' : 'NOT SET';
    res.json({ database_url: dbUrl, tables: tables.rows.map(r => r.tablename) });
  } catch(err) {
    res.json({ error: err.message, database_url: process.env.DATABASE_URL ? 'Set' : 'NOT SET' });
  }
});

// Catch-all: serve index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`TCC Compliance Checker running on port ${PORT}`);
  });
}

start();
