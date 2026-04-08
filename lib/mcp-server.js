/**
 * OpenTenders MCP Server
 * Exposes government procurement data via the Model Context Protocol.
 * Usage: node lib/mcp-server.js
 *
 * Add to Claude Code:
 *   claude mcp add opentenders -- node /path/to/OpenTenders/lib/mcp-server.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';
import { readState } from './storage.js';

const server = new Server(
  { name: 'opentenders', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_tenders',
      description: 'Search government tenders by keyword, country, sector, and date range. Returns matching tenders with titles, organizations, deadlines, and relevance scores.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Search keyword (searches title, organization, description)' },
          country: { type: 'string', description: 'Filter by country (e.g. "Pakistan", "Kenya", "Bangladesh", "Global")' },
          sector: { type: 'string', description: 'Filter by sector (e.g. "IT & Software", "Healthcare", "Finance & Banking")' },
          closing_after: { type: 'string', description: 'ISO date string — only return tenders closing after this date (e.g. "2026-04-01")' },
          closing_before: { type: 'string', description: 'ISO date string — only return tenders closing before this date' },
          min_score: { type: 'number', description: 'Minimum relevance score (0-100)' },
          limit: { type: 'number', description: 'Maximum number of results to return (default: 20, max: 100)' }
        }
      }
    },
    {
      name: 'get_tender_detail',
      description: 'Get full details for a specific tender by ID, including AI analysis, PDF findings, and sourcing information.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The tender ID (e.g. "WB-OP123", "PPRA-TS1234E")' }
        },
        required: ['id']
      }
    },
    {
      name: 'list_countries',
      description: 'List all supported countries and portals with their current status and tender counts.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'get_portal_status',
      description: 'Get live status of all configured portals — which are online/offline and how many tenders each has.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'get_stats',
      description: 'Get aggregated statistics across all portals — total tenders, breakdown by country, sector, and deadline.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case 'search_tenders':
        return { content: [{ type: 'text', text: JSON.stringify(await searchTenders(args), null, 2) }] };
      case 'get_tender_detail':
        return { content: [{ type: 'text', text: JSON.stringify(await getTenderDetail(args.id), null, 2) }] };
      case 'list_countries':
        return { content: [{ type: 'text', text: JSON.stringify(await listCountries(), null, 2) }] };
      case 'get_portal_status':
        return { content: [{ type: 'text', text: JSON.stringify(await getPortalStatus(), null, 2) }] };
      case 'get_stats':
        return { content: [{ type: 'text', text: JSON.stringify(await getStats(), null, 2) }] };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

// ── Tool implementations ──────────────────────────────────────────────────────

async function searchTenders({ keyword, country, sector, closing_after, closing_before, min_score, limit = 20 } = {}) {
  const state = await readState();
  const maxResults = Math.min(Number(limit) || 20, 100);

  let results = state.tenders || [];

  if (keyword) {
    const kw = keyword.toLowerCase();
    results = results.filter(t => {
      const hay = [t.title, t.description, t.organization, t.aiSummary, t.sector, t.category, t.source].join(' ').toLowerCase();
      return hay.includes(kw);
    });
  }

  if (country) {
    const c = country.toLowerCase();
    results = results.filter(t => {
      const tCountry = (t.country || t.province || '').toLowerCase();
      return tCountry.includes(c) || t.source?.toLowerCase().includes(c);
    });
  }

  if (sector) {
    const s = sector.toLowerCase();
    results = results.filter(t => (t.sector || t.category || t.aiSector || '').toLowerCase().includes(s));
  }

  if (closing_after) {
    results = results.filter(t => t.closing && t.closing >= closing_after);
  }

  if (closing_before) {
    results = results.filter(t => t.closing && t.closing <= closing_before);
  }

  if (min_score !== undefined) {
    results = results.filter(t => (t.fitScore || 0) >= Number(min_score));
  }

  results.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  return {
    total: results.length,
    returned: Math.min(results.length, maxResults),
    tenders: results.slice(0, maxResults).map(t => ({
      id: t.id,
      title: t.title,
      organization: t.organization,
      country: t.country || t.province || 'Pakistan',
      source: t.source,
      sector: t.sector || t.category,
      closing: t.closing,
      advertised: t.advertised,
      fitScore: t.fitScore,
      aiSummary: t.aiSummary || t.description || '',
      sourceUrl: t.sourceUrl,
      downloadUrl: t.downloadUrl || t.tenderNoticeUrl || ''
    }))
  };
}

async function getTenderDetail(id) {
  const state = await readState();
  const tender = (state.tenders || []).find(t => t.id === id);

  if (!tender) {
    return { error: `Tender not found: ${id}`, availableCount: state.tenders?.length || 0 };
  }

  return {
    ...tender,
    // Ensure all useful fields are present
    aiAnalysis: tender.pdfAnalysis ? {
      detailedSummary: tender.pdfAnalysis.detailedSummary,
      requirements: tender.pdfAnalysis.requirements,
      estimatedBudget: tender.pdfAnalysis.estimatedBudget,
      eligibility: tender.pdfAnalysis.eligibility,
      submissionMethod: tender.pdfAnalysis.submissionMethod,
      bidSecurity: tender.pdfAnalysis.bidSecurity,
      contactInfo: tender.pdfAnalysis.contactInfo,
      relevanceFit: tender.pdfAnalysis.relevanceFit || tender.pdfAnalysis.evrimFit
    } : null
  };
}

async function listCountries() {
  const portals = config.officialPortals;
  const state = await readState();

  // Count tenders by country
  const tendersByCountry = {};
  for (const t of (state.tenders || [])) {
    const c = t.country || 'Pakistan';
    tendersByCountry[c] = (tendersByCountry[c] || 0) + 1;
  }

  // Group portals by country
  const countriesMap = {};
  for (const portal of portals) {
    const country = portal.country || 'Pakistan';
    if (!countriesMap[country]) {
      countriesMap[country] = { country, flag: portal.flag || '🌍', portals: [], tenderCount: tendersByCountry[country] || 0 };
    }
    const source = (state.sources || []).find(s => s.id === portal.id);
    countriesMap[country].portals.push({
      id: portal.id,
      label: portal.label,
      url: portal.sourceUrl,
      status: source ? (source.ok ? 'online' : 'offline') : 'unknown',
      tenderCount: source?.verifiedCount || 0
    });
  }

  return {
    totalCountries: Object.keys(countriesMap).length,
    totalPortals: portals.length,
    countries: Object.values(countriesMap).sort((a, b) => b.tenderCount - a.tenderCount)
  };
}

async function getPortalStatus() {
  const state = await readState();
  const sources = state.sources || [];

  const online = sources.filter(s => s.ok);
  const offline = sources.filter(s => !s.ok);

  return {
    lastRefreshAt: state.meta?.lastRefreshAt || null,
    summary: {
      total: sources.length,
      online: online.length,
      offline: offline.length,
      totalTenders: state.tenders?.length || 0
    },
    portals: sources.map(s => ({
      id: s.id,
      label: s.label,
      country: s.country || 'Pakistan',
      flag: s.flag || '🇵🇰',
      status: s.ok ? 'online' : 'offline',
      error: s.error || null,
      scraped: s.candidateCount || 0,
      verified: s.verifiedCount || 0,
      fetchedAt: s.fetchedAt || null,
      sourceUrl: s.sourceUrl || ''
    }))
  };
}

async function getStats() {
  const state = await readState();
  const tenders = state.tenders || [];

  // By country
  const byCountry = {};
  for (const t of tenders) {
    const c = t.country || 'Pakistan';
    byCountry[c] = (byCountry[c] || 0) + 1;
  }

  // By category/sector
  const byCategory = {};
  for (const t of tenders) {
    const cat = t.category || t.sector || 'General';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }

  // By deadline urgency
  const today = new Date().toISOString().slice(0, 10);
  const in3Days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const in7Days = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const in30Days = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  const deadlineBreakdown = {
    closingIn3Days: tenders.filter(t => t.closing && t.closing >= today && t.closing <= in3Days).length,
    closingIn7Days: tenders.filter(t => t.closing && t.closing >= today && t.closing <= in7Days).length,
    closingIn30Days: tenders.filter(t => t.closing && t.closing >= today && t.closing <= in30Days).length,
    noDeadline: tenders.filter(t => !t.closing).length
  };

  // Score distribution
  const scored = tenders.filter(t => t.fitScore > 0);
  const highRelevance = tenders.filter(t => (t.fitScore || 0) >= 70).length;
  const medRelevance = tenders.filter(t => (t.fitScore || 0) >= 40 && (t.fitScore || 0) < 70).length;

  return {
    lastRefreshAt: state.meta?.lastRefreshAt || null,
    totals: {
      tenders: tenders.length,
      portals: (state.sources || []).length,
      portalsOnline: (state.sources || []).filter(s => s.ok).length
    },
    byCountry: Object.entries(byCountry).sort((a, b) => b[1] - a[1]).map(([country, count]) => ({ country, count })),
    byCategory: Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([category, count]) => ({ category, count })),
    deadlineBreakdown,
    relevanceDistribution: {
      highRelevance,
      mediumRelevance: medRelevance,
      lowRelevance: scored.length - highRelevance - medRelevance,
      unscored: tenders.length - scored.length
    }
  };
}

// ── Start server ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[OpenTenders MCP] Server running via stdio');
