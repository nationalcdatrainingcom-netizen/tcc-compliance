const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// One-time migration: pull data from Google Sheets and insert into PostgreSQL
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxi4CN5azmrYTMF1eyvo3eG25GU_4mlgtnVanA00nEOyhXDu-qRUV-TGeWt_BFyqFNA/exec';

router.post('/from-sheets', async (req, res) => {
  try {
    console.log('Migration: Fetching data from Google Sheets...');
    
    const response = await fetch(GOOGLE_SCRIPT_URL + '?tab=compliance');
    const rows = await response.json();
    
    if (!Array.isArray(rows)) {
      return res.status(502).json({ error: 'Google Sheets returned invalid data', raw: typeof rows });
    }

    console.log('Migration: Got ' + rows.length + ' rows from Google Sheets');

    // Parse rows into submission objects (same logic the frontend used)
    var submissions = [];
    rows.forEach(function(row) {
      if (!row) return;
      
      // Already a parsed object
      if (row._id || row.centerId) {
        submissions.push(row);
        return;
      }
      
      // Row with JSON Data column
      var jsonStr = row['JSON Data'] || row['json_data'] || row['data'] || row['JSON_Data'] || '';
      if (!jsonStr && Array.isArray(row)) {
        // Try last column
        for (var i = row.length - 1; i >= 0; i--) {
          var cell = String(row[i] || '').trim();
          if (cell.startsWith('{')) { jsonStr = cell; break; }
        }
      }
      if (jsonStr) {
        try {
          var parsed = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
          if (parsed && (parsed._id || parsed.centerId)) {
            // Add sheet timestamp if available
            if (row[0] || (Array.isArray(row) && row[0])) {
              parsed._sheetTimestamp = String(row[0] || row['Timestamp'] || '');
            }
            submissions.push(parsed);
          }
        } catch(e) {
          console.log('Migration: skipped unparseable row');
        }
      }
    });

    console.log('Migration: Parsed ' + submissions.length + ' submissions');

    // Insert into PostgreSQL
    var inserted = 0;
    var skipped = 0;
    var errors = 0;

    for (const data of submissions) {
      try {
        // Generate an ID if missing
        if (!data._id) {
          data._id = (data.centerId || '') + '::' + (data.classroomId || '') + '::' + (data.inspectionDate || '') + '::' + (data.teacherName || '');
        }

        // Skip test/empty records
        if (data._test || (!data.centerName && !data.classroomName && !data.centerId)) {
          skipped++;
          continue;
        }

        const subType = data.type === 'admin' ? 'admin' : 'classroom';
        const adminRole = data.adminRole || null;

        await pool.query(
          `INSERT INTO submissions (submission_id, submission_type, admin_role, center_id, center_name, classroom_id, classroom_name, inspector_name, inspection_date, submitted_date, submitted_time, pass_count, fail_count, na_count, completion, json_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           ON CONFLICT (submission_id) DO NOTHING`,
          [
            data._id, subType, adminRole,
            data.centerId || '', data.centerName || '',
            data.classroomId || '', data.classroomName || '',
            data.teacherName || '',
            data.inspectionDate || null,
            data.submittedDate || '', data.submittedTime || '',
            data.pass || 0, data.fail || 0, data.na || 0,
            data.completion || 0,
            JSON.stringify(data)
          ]
        );
        inserted++;
      } catch(e) {
        console.log('Migration: error inserting record:', e.message);
        errors++;
      }
    }

    console.log('Migration complete: ' + inserted + ' inserted, ' + skipped + ' skipped, ' + errors + ' errors');

    res.json({
      success: true,
      source_rows: rows.length,
      parsed: submissions.length,
      inserted: inserted,
      skipped: skipped,
      errors: errors
    });
  } catch(err) {
    console.error('Migration error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Check migration status
router.get('/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) as total, MIN(inspection_date) as earliest, MAX(inspection_date) as latest FROM submissions');
    const byType = await pool.query('SELECT submission_type, COUNT(*) as count FROM submissions GROUP BY submission_type');
    const byCenter = await pool.query('SELECT center_name, COUNT(*) as count FROM submissions GROUP BY center_name ORDER BY count DESC');
    
    res.json({
      total: parseInt(result.rows[0].total),
      earliest: result.rows[0].earliest,
      latest: result.rows[0].latest,
      by_type: byType.rows,
      by_center: byCenter.rows
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
