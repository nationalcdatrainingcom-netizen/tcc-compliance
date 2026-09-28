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

// ============================================================================
// ONE-TIME: remap Peace Boulevard + Montessori rooms onto the new tree rooms
// ============================================================================
// Added 2026-09-28. Commit 0a29349 renamed centre 'peace' to "Montessori",
// replaced all 11 animal rooms with 10 tree rooms, and deleted the separate
// 'montessori_center' entirely. Every classroom id changed, so every historical
// submission was orphaned: public/index.html:1405 does `if(!ctr||!rm)return;`
// and silently drops any submission whose centre/room isn't in CENTERS.
//
// Nothing was lost - this relabels the existing rows so the history reappears.
// The full annotated SQL, reasoning and rollback live in
// db/migrations/2026-09-28-peace-rooms-to-montessori.sql
//
// >>> REMOVE THESE TWO ROUTES ONCE THE REMAP HAS RUN. <<<
// This app has no server-side auth, so while they exist anyone who knows the
// URL can trigger them. Both are idempotent and /remap-apply takes a full
// backup before touching anything, so the blast radius is small - but a
// data-rewriting endpoint should not live on a public app permanently.

const REMAP_CONFIRM = 'REMAP-2026-09-28';
const REMAP_TAG = '2026-09-28-peace-rooms-to-montessori';

// Peace Boulevard animal rooms -> Montessori tree rooms.
// 'dolphins' is deliberately absent: that room closed with no successor.
const PEACE_ROOM_MAP = [
  ['caterpillars',  'seedlings',  'Seedlings'],
  ['butterflies',   'sprouts',    'Sprouts'],
  ['kangas',        'saplings_1', 'Saplings 1'],
  ['lions',         'saplings_2', 'Saplings 2'],
  ['bears',         'maple',      'Maple'],
  ['tigers',        'willow',     'Willow'],
  ['dinos',         'oak',        'Oak'],
  ['penguins',      'spruce',     'Spruce'],
  ['flamingos_pb',  'redwood',    'Redwood'],
  // montessori_pb and montessori_center's 'green' are the SAME physical room -
  // a Montessori room hosted in the Peace building, recorded under two names.
  ['montessori_pb', 'acorns',     'Acorns']
];

// Montessori centre colour rooms -> the same tree rooms. These also move
// centre, from 'montessori_center' to 'peace'.
const MONTESSORI_ROOM_MAP = [
  ['green',  'acorns',  'Acorns'],   // Infants Green
  ['purple', 'sprouts', 'Sprouts'],  // Toddler Purple
  ['red',    'redwood', 'Redwood'],  // Primary Red
  ['yellow', 'maple',   'Maple'],    // Pre-Primary Yellow
  ['orange', 'willow',  'Willow'],
  ['blue',   'oak',     'Oak'],
  ['pink',   'spruce',  'Spruce']
];

// Rooms that currently exist in CENTERS (public/index.html).
const LIVE_ROOMS = {
  peace: ['seedlings','sprouts','saplings_1','saplings_2','acorns',
          'maple','spruce','willow','oak','redwood','ADMIN'],
  niles: ['tiny_treasures','koalas','jellyfish','flamingos_n','fireflies',
          'honey_bees','otters','ADMIN']
};

function roomStatus(centerId, classroomId) {
  const live = LIVE_ROOMS[centerId];
  return live && live.indexOf(classroomId) !== -1 ? 'visible' : 'ORPHANED';
}

async function inventory() {
  const { rows } = await pool.query(
    `SELECT center_id, center_name, classroom_id, classroom_name,
            count(*)::int AS submissions,
            min(inspection_date) AS earliest,
            max(inspection_date) AS latest
       FROM submissions
      GROUP BY center_id, center_name, classroom_id, classroom_name
      ORDER BY center_id, classroom_id`
  );
  return rows.map(r => Object.assign({}, r, {
    status: roomStatus(r.center_id, r.classroom_id)
  }));
}

// ---------------------------------------------------------------------------
// GET /api/migrate/remap-preview
// Read-only. Safe to open in a browser as many times as you like.
// ---------------------------------------------------------------------------
router.get('/remap-preview', async (req, res) => {
  try {
    const inv = await inventory();
    const peaceOld = PEACE_ROOM_MAP.map(m => m[0]);
    const montOld = MONTESSORI_ROOM_MAP.map(m => m[0]);

    const willRemap = inv.filter(r =>
      (r.center_id === 'peace' && peaceOld.indexOf(r.classroom_id) !== -1) ||
      (r.center_id === 'montessori_center' && montOld.indexOf(r.classroom_id) !== -1) ||
      (r.classroom_id === 'ADMIN' && r.center_id === 'montessori_center'));

    const leftBehind = inv.filter(r =>
      r.status === 'ORPHANED' &&
      willRemap.indexOf(r) === -1);

    res.json({
      mode: 'preview - nothing has been changed',
      totals: {
        submissions: inv.reduce((s, r) => s + r.submissions, 0),
        visible_now: inv.filter(r => r.status === 'visible')
                        .reduce((s, r) => s + r.submissions, 0),
        orphaned_now: inv.filter(r => r.status === 'ORPHANED')
                         .reduce((s, r) => s + r.submissions, 0),
        would_be_remapped: willRemap.reduce((s, r) => s + r.submissions, 0)
      },
      will_remap: willRemap,
      will_stay_orphaned: leftBehind,
      note: leftBehind.length
        ? 'Rooms listed in will_stay_orphaned have no successor room and stay hidden.'
        : 'Everything orphaned has a mapping.',
      to_apply: 'POST or GET /api/migrate/remap-apply?confirm=' + REMAP_CONFIRM
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET or POST /api/migrate/remap-apply?confirm=REMAP-2026-09-28
// Backs up, then remaps inside a transaction. Idempotent: running it again
// changes nothing and never overwrites the original labels it recorded.
// ---------------------------------------------------------------------------
async function applyRemap(req, res) {
  const confirm = (req.query && req.query.confirm) ||
                  (req.body && req.body.confirm);
  if (confirm !== REMAP_CONFIRM) {
    return res.status(400).json({
      error: 'Missing or wrong confirmation phrase.',
      hint: 'Add ?confirm=' + REMAP_CONFIRM + ' to the URL.'
    });
  }

  const client = await pool.connect();
  try {
    const before = await inventory();

    // 1. Full backup BEFORE anything changes. Safe to re-run: IF NOT EXISTS
    //    means the first backup (the true pre-migration state) is kept.
    await client.query(
      `CREATE TABLE IF NOT EXISTS submissions_backup_20260928 AS
         SELECT * FROM submissions`
    );
    const backup = await client.query(
      `SELECT count(*)::int AS n FROM submissions_backup_20260928`);
    const liveCount = await client.query(
      `SELECT count(*)::int AS n FROM submissions`);

    await client.query('BEGIN');

    const provenance = `jsonb_build_object(
      'centerId', s.center_id, 'classroomId', s.classroom_id,
      'classroomName', s.classroom_name, 'centerName', s.center_name,
      'migratedAt', now()::text, 'migration', '${REMAP_TAG}')`;

    let peaceRows = 0, montRows = 0, adminRows = 0;

    // 2a. Peace Boulevard rooms - classroom changes, centre already 'peace'.
    for (const [oldId, newId, newName] of PEACE_ROOM_MAP) {
      const r = await client.query(
        `UPDATE submissions s
            SET classroom_id = $2::text,
                classroom_name = $3::text,
                center_name = 'Montessori',
                json_data = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
                  s.json_data,
                  '{classroomId}',   to_jsonb($2::text)),
                  '{classroomName}', to_jsonb($3::text)),
                  '{centerName}',    to_jsonb('Montessori'::text)),
                  '{_migratedFrom}', ${provenance})
          WHERE s.center_id = 'peace' AND s.classroom_id = $1`,
        [oldId, newId, newName]);
      peaceRows += r.rowCount;
    }

    // 2b. Montessori centre rooms - classroom AND centre change.
    for (const [oldId, newId, newName] of MONTESSORI_ROOM_MAP) {
      const r = await client.query(
        `UPDATE submissions s
            SET center_id = 'peace',
                center_name = 'Montessori',
                classroom_id = $2::text,
                classroom_name = $3::text,
                json_data = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
                  s.json_data,
                  '{centerId}',      to_jsonb('peace'::text)),
                  '{classroomId}',   to_jsonb($2::text)),
                  '{classroomName}', to_jsonb($3::text)),
                  '{centerName}',    to_jsonb('Montessori'::text)),
                  '{_migratedFrom}', ${provenance})
          WHERE s.center_id = 'montessori_center' AND s.classroom_id = $1`,
        [oldId, newId, newName]);
      montRows += r.rowCount;
    }

    // 2c. Administrative submissions keep room id 'ADMIN' but still carry the
    //     old centre label.
    const adm = await client.query(
      `UPDATE submissions s
          SET center_id = 'peace',
              center_name = 'Montessori',
              json_data = jsonb_set(jsonb_set(jsonb_set(
                s.json_data,
                '{centerId}',   to_jsonb('peace'::text)),
                '{centerName}', to_jsonb('Montessori'::text)),
                '{_migratedFrom}', ${provenance})
        WHERE s.classroom_id = 'ADMIN'
          AND s.center_id IN ('peace','montessori_center')
          AND (s.center_id <> 'peace'
               OR s.center_name IS DISTINCT FROM 'Montessori')`);
    adminRows = adm.rowCount;

    await client.query('COMMIT');

    const after = await inventory();
    const stillOrphaned = after.filter(r => r.status === 'ORPHANED');

    res.json({
      success: true,
      backup_table: 'submissions_backup_20260928',
      backup_rows: backup.rows[0].n,
      live_rows: liveCount.rows[0].n,
      updated: {
        peace_rooms: peaceRows,
        montessori_rooms: montRows,
        admin: adminRows,
        total: peaceRows + montRows + adminRows
      },
      visible_before: before.filter(r => r.status === 'visible')
                            .reduce((s, r) => s + r.submissions, 0),
      visible_after: after.filter(r => r.status === 'visible')
                          .reduce((s, r) => s + r.submissions, 0),
      still_orphaned: stillOrphaned,
      after: after,
      idempotent: 'Running this again will report 0 updated and change nothing.'
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Remap error:', err);
    res.status(500).json({ error: err.message, rolled_back: true });
  } finally {
    client.release();
  }
}

router.get('/remap-apply', applyRemap);
router.post('/remap-apply', applyRemap);

// ---------------------------------------------------------------------------
// GET /api/migrate/remap-duplicates
// Read-only review: same room, same date, more than one write-up. Peace and
// the Montessori centre both kept books on the shared Montessori/Green room,
// so some visits exist twice. Nothing is deduplicated automatically.
// ---------------------------------------------------------------------------
router.get('/remap-duplicates', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT classroom_id, classroom_name, inspection_date,
              count(*)::int AS records,
              string_agg(DISTINCT coalesce(
                json_data->'_migratedFrom'->>'centerName','not migrated'),
                ' + ') AS from_books,
              string_agg(DISTINCT inspector_name, ', ') AS inspectors
         FROM submissions
        WHERE center_id = 'peace' AND submission_type = 'classroom'
        GROUP BY classroom_id, classroom_name, inspection_date
       HAVING count(*) > 1
        ORDER BY classroom_id, inspection_date`);
    res.json({ duplicate_candidates: rows.length, rows: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
