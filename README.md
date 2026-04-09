# TCC Compliance Checker v2.0

Multi-mode compliance inspection tool for The Children's Center with AI-powered document verification.

## Features

### Current (v1 → v2 migration)
- **5 inspection modes**: Classroom, Director, HR, Records, Dashboard
- **Classroom inspections**: Age-filtered checklists for lead teachers
- **Director inspections**: Licensing, emergency prep, ratios, food service, etc.
- **HR inspections**: Staff records, qualifications, training, background checks
- **Records inspections**: Children's records, immunizations, attendance
- **Dashboard**: Monthly classroom reports + quarterly admin sign-off cards
- **Cloud sync**: Google Sheets backend for submissions
- **SSO**: Hub integration via URL parameters

### New in v2 (AI Document Verification)
- **Document upload**: Store PDFs (handbooks, licenses, fire reports) in PostgreSQL
- **AI analysis**: Claude reads uploaded documents and matches content to licensing requirements
- **Director review**: Approve/reject AI-suggested policy matches with source, page, and content
- **Compliance report**: Printable packet for licensing consultant with all approved evidence
- **Document library**: Current license, fire safety report, inspection reports on file

## Architecture

```
tcc-compliance/
├── server.js              # Express server
├── package.json
├── render.yaml            # Render deployment config
├── .env.example           # Environment variables template
├── public/
│   └── index.html         # Full compliance checker app (single-file PWA)
├── db/
│   ├── index.js           # PostgreSQL connection pool
│   └── schema.sql         # Database schema
└── routes/
    ├── documents.js       # Document upload/download/list
    ├── analysis.js        # AI analysis + policy match management
    └── report.js          # Compliance report generation
```

## API Endpoints

### Documents
- `POST /api/documents/upload` — Upload a document (multipart form)
- `GET /api/documents/list/:centerId` — List all documents for a center
- `GET /api/documents/active/:centerId` — List only current/active documents
- `GET /api/documents/file/:id` — Download/view a document
- `DELETE /api/documents/:id` — Deactivate a document

### AI Analysis
- `POST /api/analysis/analyze` — Send a document + requirements to Claude for matching
- `GET /api/analysis/matches/:centerId` — Get all policy matches for a center
- `PUT /api/analysis/matches/:id/review` — Approve or reject a match
- `POST /api/analysis/matches/manual` — Manually link a requirement to a document section

### Report
- `GET /api/report/:centerId` — Generate compliance report data

### Health
- `GET /api/health` — Server status check

## Deployment (Render)

1. Create a new **Web Service** on Render from this repo
2. Create a **PostgreSQL** database
3. Set environment variables:
   - `DATABASE_URL` — from the PostgreSQL instance
   - `ANTHROPIC_API_KEY` — your Claude API key
   - `NODE_ENV` — `production`
4. Build command: `npm install`
5. Start command: `node server.js`

## Important Notes

- **Google Sheets sync is preserved** — the existing SCRIPT_URL in index.html continues to work
- **No data migration needed** — all existing submissions stay in Google Sheets
- **PostgreSQL stores new data only**: uploaded documents, AI matches, and compliance report data
- The `public/index.html` should be the latest version from the tcc-compliance GitHub repo

## Document Types

| doc_type | Description | AI Analyzable |
|----------|-------------|---------------|
| parent_handbook | Parent Handbook | ✅ Yes |
| staff_handbook | Staff Handbook | ✅ Yes |
| emergency_plan | Emergency Preparedness Plan | ✅ Yes |
| license | Current Child Care License | ❌ Upload only |
| fire_report | Fire Safety Report | ❌ Upload only |
| fire_alarm | Fire Alarm Inspection | ❌ Upload only |
| cpsi_report | CPSI Playground Inspection | ❌ Upload only |
| water_test | Water Testing Results | ❌ Upload only |
| other | Other Required Documents | Depends |
