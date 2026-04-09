const express = require('express');
const router = express.Router();
const { pool } = require('../db');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Analyze a document against specific requirements
router.post('/analyze', async (req, res) => {
  try {
    const { document_id, center_id, requirements } = req.body;
    // requirements = [{ item_id, category_id, rule, text }, ...]

    if (!document_id || !center_id || !requirements || !requirements.length) {
      return res.status(400).json({ error: 'Missing document_id, center_id, or requirements' });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    // Fetch the document
    const docResult = await pool.query(
      'SELECT id, doc_label, file_name, mime_type, file_data FROM documents WHERE id = $1 AND is_active = TRUE',
      [document_id]
    );
    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];
    const base64Data = doc.file_data.toString('base64');

    // Build the requirements list for the prompt
    const reqList = requirements.map((r, i) =>
      `${i + 1}. [${r.item_id}] ${r.text} (Rule: ${r.rule})`
    ).join('\n');

    // Build Claude API request
    const messages = [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: doc.mime_type,
            data: base64Data
          }
        },
        {
          type: 'text',
          text: `You are a Michigan child care licensing compliance analyst. I've uploaded a document titled "${doc.doc_label}" (${doc.file_name}).

Please analyze this document and find content that satisfies each of the following Michigan licensing requirements. For each requirement, identify the specific section, page, or passage that addresses it.

REQUIREMENTS TO MATCH:
${reqList}

For each requirement, respond with a JSON array. Each element should have:
- "item_id": the bracketed ID from the requirement
- "status": "found" if the document contains content addressing this requirement, "partial" if only partially addressed, "not_found" if not present
- "confidence": "high", "medium", or "low"
- "page_reference": the page number(s) or section where found (e.g. "Page 4", "Pages 7-8", "Section 3")
- "matched_content": the EXACT text from the document that satisfies this requirement (copy verbatim - this will be shown to the director for approval). Include enough context for it to be meaningful, typically 1-3 paragraphs.
- "summary": a brief 1-sentence explanation of how this content meets the requirement

Respond ONLY with the JSON array, no markdown fences, no preamble.`
        }
      ]
    }];

    const apiResponse = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000,
        messages
      })
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error('Anthropic API error:', errText);
      return res.status(502).json({ error: 'AI analysis failed', details: errText });
    }

    const apiData = await apiResponse.json();
    const responseText = apiData.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');

    // Parse the AI response
    let matches;
    try {
      const cleaned = responseText.replace(/```json|```/g, '').trim();
      matches = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse AI response:', responseText.substring(0, 500));
      return res.status(502).json({ error: 'Could not parse AI response', raw: responseText.substring(0, 1000) });
    }

    // Store matches in database
    const stored = [];
    for (const match of matches) {
      const req_item = requirements.find(r => r.item_id === match.item_id);
      if (!req_item) continue;

      const confidence = match.confidence || (match.status === 'found' ? 'high' : match.status === 'partial' ? 'medium' : 'low');

      const upsertResult = await pool.query(
        `INSERT INTO policy_matches (center_id, item_id, category_id, rule_citation, requirement_text, document_id, source_document, page_reference, matched_content, ai_confidence, ai_summary, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NOW())
         ON CONFLICT (center_id, item_id) DO UPDATE SET
           document_id = $6, source_document = $7, page_reference = $8, matched_content = $9,
           ai_confidence = $10, ai_summary = $11, status = 'pending', updated_at = NOW()
         RETURNING *`,
        [
          center_id, match.item_id, req_item.category_id, req_item.rule,
          req_item.text, document_id, doc.doc_label,
          match.page_reference || null, match.matched_content || null,
          confidence, match.summary || null
        ]
      );
      stored.push(upsertResult.rows[0]);
    }

    res.json({
      success: true,
      document: doc.doc_label,
      total_requirements: requirements.length,
      found: matches.filter(m => m.status === 'found').length,
      partial: matches.filter(m => m.status === 'partial').length,
      not_found: matches.filter(m => m.status === 'not_found').length,
      matches: stored
    });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all policy matches for a center
router.get('/matches/:centerId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pm.*, d.doc_label as current_doc_label
       FROM policy_matches pm
       LEFT JOIN documents d ON pm.document_id = d.id
       WHERE pm.center_id = $1
       ORDER BY pm.category_id, pm.item_id`,
      [req.params.centerId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve or reject a match
router.put('/matches/:id/review', async (req, res) => {
  try {
    const { status, reviewed_by, review_notes } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
    }

    const result = await pool.query(
      `UPDATE policy_matches SET status = $1, reviewed_by = $2, reviewed_at = NOW(), review_notes = $3, updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [status, reviewed_by, review_notes || null, req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Match not found' });
    res.json({ success: true, match: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual match — director links a requirement to a document section manually
router.post('/matches/manual', async (req, res) => {
  try {
    const { center_id, item_id, category_id, rule_citation, requirement_text,
            document_id, source_document, page_reference, matched_content,
            reviewed_by, review_notes } = req.body;

    const result = await pool.query(
      `INSERT INTO policy_matches (center_id, item_id, category_id, rule_citation, requirement_text, document_id, source_document, page_reference, matched_content, ai_confidence, ai_summary, status, reviewed_by, reviewed_at, review_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', 'Manually linked by director', 'approved', $10, NOW(), $11)
       ON CONFLICT (center_id, item_id) DO UPDATE SET
         document_id = $6, source_document = $7, page_reference = $8, matched_content = $9,
         ai_confidence = 'manual', status = 'approved', reviewed_by = $10, reviewed_at = NOW(), review_notes = $11, updated_at = NOW()
       RETURNING *`,
      [center_id, item_id, category_id, rule_citation, requirement_text,
       document_id, source_document, page_reference, matched_content,
       reviewed_by, review_notes || null]
    );

    res.json({ success: true, match: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
