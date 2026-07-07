# Booky

Booky turns PDF ebooks into a clean, accessible reading experience in the browser. Upload a PDF, and Booky extracts text and illustrations, detects chapters, and lays out pages tuned for comfortable reading—with adjustable typography, progress tracking, and optional reformatted exports.

**Live app:** [booky-lemon.vercel.app](https://booky-lemon.vercel.app)

## Stack

| Layer | Tech |
|-------|------|
| Client | React 19, Vite, React Router, PDF.js (pagination) |
| Server | Node.js, Express 5, pdfjs-dist, Tesseract.js (header OCR) |
| Auth | [Clerk](https://clerk.com) |
| Storage | [Supabase](https://supabase.com) (Postgres + object storage) |
| Deploy | Vercel (client), Render (API) |

## Project layout

```
Booky/
├── client/          # Vite SPA — upload, library, reader
├── server/          # Express API — PDF parse pipeline, document CRUD
│   └── scripts/
│       └── regression/   # Parser regression harness
└── README.md
```

## Local development

### Prerequisites

- Node.js 20+
- Clerk application (publishable + secret keys)
- Supabase project with `documents` table and `pdfs` storage bucket
- Optional: [Poppler](https://poppler.freedesktop.org/) (`pdftotext` on PATH) for regression word-count checks

### Server

```bash
cd server
npm install
```

Create `server/.env`:

```env
PORT=3000
CLIENT_URL=http://localhost:5173

# Clerk
CLERK_SECRET_KEY=sk_test_...

# Supabase (service role — server only)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...

# Optional
ADMIN_SECRET=...                    # POST /admin/reparse
BOOKY_REPARSE_ON_BOOT=1             # Re-parse outdated docs on server start
BOOKY_TEXT_EXTRACTION_CONCURRENCY=4
BOOKY_IMAGE_EXTRACTION_CONCURRENCY=2
```

```bash
npm run dev    # node --watch index.js
```

### Client

```bash
cd client
npm install
```

Create `client/.env`:

```env
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_API_URL=http://localhost:3000

# Optional — only if the client talks to Supabase directly
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

```bash
npm run dev    # http://localhost:5173
```

## Parser

PDFs are parsed on the server (`server/index.js`). The pipeline:

1. Extract text and artwork per page (pdfjs-dist)
2. Build blocks (headings, prose, images)
3. Classify illustrations and OCR chapter headers where needed
4. Detect chapters and assign boundaries
5. Persist structured content to Supabase

**Parser version** is defined by `PARSER_VERSION` in `server/index.js` and `client/src/components/BookViewer.jsx` (currently `115` - the two must match). Bump both when parser output changes so cached pagination and stored documents re-parse correctly.

### Regression tests

Place test PDFs in `client/src/assets/`, then from `server/`:

```bash
npm run regression
npm run regression -- --book=oldman
npm run regression:update   # refresh local snapshots
```

Books in the harness: `oldman`, `orwell1984`, `monte-cristo`, `pride-prejudice`, `moby-dick`.

See [server/scripts/regression/README.md](server/scripts/regression/README.md) for adding books and interpreting results.

### Diff a single PDF

```bash
cd server
npm run diff-pdf -- "client/src/assets/My Book.pdf"
```

## Deployment

- **Client:** Deploy `client/` to Vercel. Set `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_API_URL` (your Render API URL).
- **Server:** Deploy `server/` to Render (or similar). Set Clerk, Supabase, and `CLIENT_URL` / `ALLOWED_ORIGINS` to your Vercel origin (e.g. `https://booky-lemon.vercel.app`).

CORS allows `localhost:5173`, `localhost:4173`, and `https://booky-lemon.vercel.app` by default; add more via `ALLOWED_ORIGINS` (comma-separated). Vercel preview URLs matching `*.vercel.app` are also accepted.

## Routes

| Path | Description |
|------|-------------|
| `/` | Upload a PDF |
| `/library` | Your saved books |
| `/read/:id` | Reader with pagination and settings |

## License

ISC (server package). See repository for details.