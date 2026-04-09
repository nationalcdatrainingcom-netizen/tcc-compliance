const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../db');

// Configure multer for memory storage (we'll store in PostgreSQL)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files are allowed'));
    }
  }
});

// Upload a document
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { center_id, doc_type, doc_label, uploaded_by, notes } = req.body;
    if (!center_id || !doc_type || !doc_label || !uploaded_by) {
      return res.status(400).json({ error: 'Missing required fields: center_id, doc_type, doc_label, uploaded_by' });
    }

    // Deactivate any existing active document of same type for this center
    await pool.query(
      'UPDATE documents SET is_active = FALSE WHERE center_id = $1 AND doc_type = $2 AND is_active = TRUE',
      [center_id, doc_type]
    );

    const result = await pool.query(
      `INSERT INTO documents (center_id, doc_type, doc_label, file_name, mime_type, file_data, file_size, uploaded_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, center_id, doc_type, doc_label, file_name, mime_type, file_size, uploaded_by, uploaded_at, notes`,
      [center_id, doc_type, doc_label, req.file.originalname, req.file.mimetype, req.file.buffer, req.file.size, uploaded_by, notes || null]
    );

    res.json({ success: true, document: result.rows[0] });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List documents for a center
router.get('/list/:centerId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, center_id, doc_type, doc_label, file_name, mime_type, file_size, uploaded_by, uploaded_at, notes, is_active
       FROM documents WHERE center_id = $1 ORDER BY is_active DESC, uploaded_at DESC`,
      [req.params.centerId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get active documents for a center (current versions only)
router.get('/active/:centerId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, center_id, doc_type, doc_label, file_name, mime_type, file_size, uploaded_by, uploaded_at, notes
       FROM documents WHERE center_id = $1 AND is_active = TRUE ORDER BY doc_type, uploaded_at DESC`,
      [req.params.centerId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download/view a document
router.get('/file/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT file_name, mime_type, file_data FROM documents WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Document not found' });

    const doc = result.rows[0];
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
    res.send(doc.file_data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete (deactivate) a document
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('UPDATE documents SET is_active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
