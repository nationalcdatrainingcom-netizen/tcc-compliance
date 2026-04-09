-- TCC Compliance Checker Database Schema
-- Render PostgreSQL

-- Documents uploaded by directors (handbooks, licenses, fire reports, etc.)
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  center_id VARCHAR(50) NOT NULL,
  doc_type VARCHAR(50) NOT NULL,  -- 'parent_handbook', 'staff_handbook', 'emergency_plan', 'license', 'fire_report', 'fire_alarm', 'cpsi_report', 'water_test', 'other'
  doc_label VARCHAR(255) NOT NULL, -- display name e.g. "Parent Handbook 2026"
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  file_data BYTEA NOT NULL,
  file_size INTEGER NOT NULL,
  uploaded_by VARCHAR(100) NOT NULL,
  uploaded_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE,
  notes TEXT
);

-- AI-suggested policy matches (one per requirement per center)
CREATE TABLE IF NOT EXISTS policy_matches (
  id SERIAL PRIMARY KEY,
  center_id VARCHAR(50) NOT NULL,
  item_id VARCHAR(100) NOT NULL,        -- matches ADMIN_CATEGORIES item id e.g. 'adm_handbook_discipline'
  category_id VARCHAR(100) NOT NULL,    -- e.g. 'admin_parent_info'
  rule_citation VARCHAR(100),           -- e.g. 'R 400.8113(1)(d)'
  requirement_text TEXT NOT NULL,       -- the full requirement text from the checklist
  document_id INTEGER REFERENCES documents(id),
  source_document VARCHAR(255),         -- doc label for display
  page_reference VARCHAR(100),          -- e.g. 'Page 4', 'Pages 12-13'
  matched_content TEXT,                 -- the exact excerpt from the document
  ai_confidence VARCHAR(20),            -- 'high', 'medium', 'low', 'not_found'
  ai_summary TEXT,                      -- AI's brief explanation of why this matches
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'manual'
  reviewed_by VARCHAR(100),
  reviewed_at TIMESTAMP,
  review_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(center_id, item_id)
);

-- Compliance submissions (mirrors what's in Google Sheets, for local backup)
CREATE TABLE IF NOT EXISTS submissions (
  id SERIAL PRIMARY KEY,
  submission_id VARCHAR(100) UNIQUE NOT NULL, -- the _id from the app
  submission_type VARCHAR(20) DEFAULT 'classroom', -- 'classroom' or 'admin'
  admin_role VARCHAR(20),              -- 'director', 'hr', 'records' (null for classroom)
  center_id VARCHAR(50) NOT NULL,
  center_name VARCHAR(100),
  classroom_id VARCHAR(50),
  classroom_name VARCHAR(100),
  inspector_name VARCHAR(100),
  inspection_date DATE,
  submitted_date VARCHAR(50),
  submitted_time VARCHAR(50),
  pass_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  na_count INTEGER DEFAULT 0,
  completion INTEGER DEFAULT 0,
  json_data JSONB NOT NULL,            -- full submission data
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_documents_center ON documents(center_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_policy_matches_center ON policy_matches(center_id, status);
CREATE INDEX IF NOT EXISTS idx_submissions_center ON submissions(center_id, submission_type);
CREATE INDEX IF NOT EXISTS idx_submissions_date ON submissions(inspection_date DESC);
