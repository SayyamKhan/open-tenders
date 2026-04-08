# OpenTenders

**Open source global government procurement intelligence.**
Because public contracts should be publicly accessible.

[![Node](https://img.shields.io/badge/Node-22%2B-green?logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)
[![Portals](https://img.shields.io/badge/Portals-10-orange)]()
[![Countries](https://img.shields.io/badge/Countries-5-purple)]()

---

## The Problem

$13 trillion in government contracts are awarded every year. This money belongs to the public. The opportunities belong to companies, NGOs, and researchers worldwide.

But accessing this data is a nightmare:

- Each country has a different portal with a different design
- Most portals have no public API
- Pagination is inconsistent, formats differ wildly
- No single place to search across countries
- No AI enrichment, no scoring, no developer access

OpenTenders fixes this.

---

## What It Does

OpenTenders is a self-hosted procurement intelligence platform that:

- **Scrapes** official government procurement portals using Playwright (stealth mode)
- **Calls** REST APIs for portals that have them (World Bank)
- **Parses** tender data into a normalized schema
- **Scores** every tender for IT/tech relevance using heuristics + Claude AI
- **Serves** a beautiful dark-mode dashboard and a REST API
- **Exposes** an MCP server for Claude Code integration

---

## Supported Portals

| Country | Portal | Method | Status |
|---------|--------|--------|--------|
| 🇵🇰 Pakistan | [PPRA (EPMS)](https://epms.ppra.gov.pk/public/tenders/active-tenders) | Browser | ✅ Active |
| 🇵🇰 Pakistan | [PPRA (EPADS v2)](https://epads.gov.pk) | Browser | ✅ Active |
| 🇵🇰 Pakistan | [Punjab e-Procurement](https://eproc.punjab.gov.pk) | Browser | ✅ Active |
| 🇵🇰 Pakistan | [MoITT](https://moitt.gov.pk/Tenders) | Browser | ✅ Active |
| 🇵🇰 Pakistan | [KPPRA KPK](http://www.kppra.gov.pk) | Browser | ✅ Active |
| 🇵🇰 Pakistan | [AJK PPRA](https://www.ajkppra.gov.pk) | Browser | ✅ Active |
| 🌍 Global | [World Bank Procurement](https://search.worldbank.org/api/v2/procurement) | REST API | ✅ Active |
| 🇧🇩 Bangladesh | [CPTU](https://www.cptu.gov.bd) | Browser | ✅ Active |
| 🇰🇪 Kenya | [PPRA Kenya](https://ppra.go.ke) | Browser | ✅ Active |
| 🌍 Africa | [African Dev Bank](https://www.afdb.org/en/projects-and-operations/procurement) | Browser | ✅ Active |

---

## Quick Start

Get up and running in under 5 minutes.

### Prerequisites

- Node.js 22+
- npm

### 1. Clone and install

```bash
git clone https://github.com/sayyamkhan/opentenders
cd opentenders
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# Required
AUTH_SECRET=your-random-secret-here   # generate: openssl rand -hex 32

# Optional — enables AI summaries and smart scoring
ANTHROPIC_API_KEY=sk-ant-api03-...
```

### 3. Create your first user

```bash
node scripts/hash-password.js myusername mypassword
```

Copy the output into `data/users.json`:

```json
{
  "users": [
    {
      "username": "admin",
      "salt": "...",
      "hash": "...",
      "role": "master",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "createdBy": "system"
    }
  ]
}
```

### 4. Run

```bash
npm start
```

Visit `http://localhost:3001` and sign in.

### 5. Refresh

Click **Refresh** in the top-right to scrape all portals. First run takes 5-10 minutes.

---

## MCP Integration (Claude Code)

OpenTenders ships an MCP server so you can query procurement data directly in Claude Code.

### Setup

```bash
claude mcp add opentenders -- node /path/to/OpenTenders/lib/mcp-server.js
```

### Available Tools

| Tool | Description |
|------|-------------|
| `search_tenders` | Search by keyword, country, sector, date range, min score |
| `get_tender_detail` | Get full tender data including AI analysis |
| `list_countries` | List all supported countries and portals |
| `get_portal_status` | Live status of all portals (online/offline, tender counts) |
| `get_stats` | Aggregated stats — totals, country breakdown, urgency, relevance |

### Example Usage in Claude

```
What are the open IT tenders in Kenya closing this month?
```

```
Search for tenders related to hospital management systems with a score above 70
```

```
What's the status of the World Bank portal? How many tenders do we have?
```

---

## API Reference

All endpoints require authentication (cookie-based session).

### `GET /api/tenders`

Returns paginated, filtered tenders.

**Query params:**
| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Full-text search |
| `countries` | string | Comma-separated country names |
| `category` | string | Category filter |
| `source` | string | Portal source filter |
| `deadline` | number | Days until closing (3, 7, 14, 30) |
| `score` | number | Min score (1, 40, 70) |
| `sort` | string | `closing_asc`, `closing_desc`, `score`, `newest` |
| `page` | number | Page number |
| `limit` | number | Per page (25, 50, 100, or `all`) |

**Response:**
```json
{
  "tenders": [...],
  "sources": [...],
  "meta": { "lastRefreshAt": "...", "totals": { "tenders": 342 } },
  "pagination": { "page": 1, "totalPages": 7, "totalFiltered": 342 }
}
```

### `POST /api/refresh`

Triggers a portal refresh (async). Monitor progress via SSE.

### `GET /api/refresh/progress`

Server-Sent Events stream for live refresh progress.

### `GET /api/health`

Health check. Returns `200 OK` when healthy.

---

## How to Add a New Country/Portal

1. **Add the portal to `lib/config.js`**:

```js
{
  id: 'india-gem',
  label: 'India GeM',
  country: 'India',
  flag: '🇮🇳',
  province: '',
  city: 'New Delhi',
  sourceUrl: 'https://gem.gov.in/buyer_tenders'
  // For API-based: add type: 'api'
}
```

2. **Add a parser in `lib/parsers.js`**:

```js
// In the switch statement:
case 'india-gem':
  return parseIndiaGem(snapshot);

// Parser function:
function parseIndiaGem(snapshot) {
  const candidates = [];
  // Use detectHeaderRow() to find table headers
  // Extract: id, title, organization, closing, sourceUrl, etc.
  // Return array of candidate objects
  return candidates;
}
```

3. **Add trusted hosts to `lib/refresh.js`**:

```js
const OFFICIAL_HOSTS = new Set([
  // ... existing hosts
  'gem.gov.in', 'www.gem.gov.in'
]);
```

4. **For API portals**, handle in `lib/sources.js`:

```js
async function fetchApiSnapshot(source) {
  if (source.id === 'india-gem') return fetchIndiaGemSnapshot(source, startedAt);
  // ...
}
```

All done. The portal will appear in the dashboard and MCP server automatically.

---

## Architecture

```
OpenTenders/
├── server.js           # Express server, REST API
├── lib/
│   ├── config.js       # Portal config, keywords, env loading
│   ├── sources.js      # Playwright browser scraping + API fetching
│   ├── parsers.js      # Per-portal HTML/JSON parsers
│   ├── refresh.js      # Orchestration: scrape → parse → score → save
│   ├── ai.js           # Claude AI enrichment (optional)
│   ├── storage.js      # Atomic JSON file storage
│   ├── auth.js         # Cookie-based auth, scrypt password hashing
│   ├── pdf-utils.js    # PDF text extraction
│   └── mcp-server.js   # MCP server for Claude Code integration
├── public/
│   ├── index.html      # Main dashboard
│   ├── login.html      # Login page
│   ├── styles.css      # Dark mode design system
│   └── app.js          # Frontend (vanilla JS, no build step)
├── data/               # JSON data files (gitignored)
└── scripts/
    └── hash-password.js # Password hashing utility
```

---

## Dashboard Features

- **Country selector** — flag icons for each country, click to toggle on/off
- **Global stats bar** — total tenders, portals online/offline, country count, last scan time
- **Portal status cards** — per-portal status with country flag, tender counts, error details
- **Tender feed** — filterable list with title, country flag, portal, deadline, score
- **AI summaries** — Claude-generated summaries for every tender (optional)
- **PDF analysis** — Deep document analysis: requirements, budget, eligibility
- **Team features** — Claim tenders, track status, add notes, reassign
- **Export** — Download filtered results as CSV
- **Dark mode** — Black background, magenta accent (#E8047E)

---

## Roadmap

- [ ] 50 countries (India GeM, Nigeria BPP, Ghana PPA, Indonesia LPSE, and more)
- [ ] Real-time alerts via email/Slack when new matching tenders appear
- [ ] ML-based opportunity scoring (beyond keyword heuristics)
- [ ] Public REST API with API key management
- [ ] Hosted version at opentenders.dev
- [ ] Tender archival and historical analytics
- [ ] Webhook support for custom integrations
- [ ] Multi-language support (Arabic, French, Swahili)

---

## Contributing

Pull requests welcome. For major changes, open an issue first.

```bash
git clone https://github.com/sayyamkhan/opentenders
cd opentenders
npm install
cp .env.example .env
# add your AUTH_SECRET to .env
npm run dev
```

---

## License

MIT — see [LICENSE](LICENSE)

Built by [Sayyam Khan](https://sayyamkhan.dev)
