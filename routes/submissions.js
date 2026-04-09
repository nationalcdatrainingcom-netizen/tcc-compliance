const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Submit a new inspection (classroom or admin)
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data._id) {
      return res.status(400).json({ error: 'Missing submission data' });
    }

    const subType = data.type === 'admin' ? 'admin' : 'classroom';
    const adminRole = data.adminRole || null;

    const result = await pool.query(
      `INSERT INTO submissions (submission_id, submission_type, admin_role, center_id, center_name, classroom_id, classroom_name, inspector_name, inspection_date, submitted_date, submitted_time, pass_count, fail_count, na_count, completion, json_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (submission_id) DO NOTHING
       RETURNING id`,
      [
        data._id, subType, adminRole,
        data.centerId, data.centerName,
        data.classroomId, data.classroomName,
        data.teacherName,
        data.inspectionDate || null,
        data.submittedDate, data.submittedTime,
        data.pass || 0, data.fail || 0, data.na || 0,
        data.completion || 0,
        JSON.stringify(data)
      ]
    );

    res.json({ success: true, id: result.rows[0]?.id || null });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Load all submissions (replaces Google Sheets cloudLoad)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT json_data FROM submissions ORDER BY created_at DESC`
    );
    const submissions = result.rows.map(r => {
      const data = typeof r.json_data === 'string' ? JSON.parse(r.json_data) : r.json_data;
      return data;
    });
    res.json(submissions);
  } catch (err) {
    console.error('Load error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Load submissions filtered by center
router.get('/center/:centerId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT json_data FROM submissions WHERE center_id = $1 ORDER BY created_at DESC`,
      [req.params.centerId]
    );
    const submissions = result.rows.map(r => {
      const data = typeof r.json_data === 'string' ? JSON.parse(r.json_data) : r.json_data;
      return data;
    });
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a submission
router.delete('/:submissionId', async (req, res) => {
  try {
    await pool.query('DELETE FROM submissions WHERE submission_id = $1', [req.params.submissionId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
