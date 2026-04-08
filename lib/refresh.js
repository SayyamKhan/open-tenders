import { config } from './config.js';
import { EventEmitter } from 'events';
import { extractDeterministicCandidates, scoreTenderHeuristically, smartTitle, boostFromPdfContent, categorizeTender } from './parsers.js';
import { collectSnapshots } from './sources.js';
import { readState, writeState, archiveOldTenders, readBookmarks } from './storage.js';
import { extractPdfText } from './pdf-utils.js';
import { enrichTendersWithAI, deepAnalyzePdfs } from './ai.js';

let inFlightRefresh = null;

/** Progress event emitter — emits 'progress' events with { step, detail, portal, done, total } */
export const refreshProgress = new EventEmitter();
refreshProgress.setMaxListeners(50);

function emitProgress(step, detail, extra = {}) {
  refreshProgress.emit('progress', { step, detail, ts: Date.now(), ...extra });
}

export async function getCurrentState() {
  return readState();
}

export async function refreshAll({ manual = false } = {}) {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    const totalPortals = config.officialPortals.length;
    emitProgress('scraping', `Scraping ${totalPortals} portals...`, { done: 0, total: totalPortals });
    const snapshots = await collectSnapshots((portal, idx, status) => {
      emitProgress('scraping', status === 'start'
        ? `Scraping ${portal.label}...`
        : status === 'retry'
        ? `Retrying ${portal.label}...`
        : `${portal.label} done`,
        { portal: portal.label, done: idx + (status === 'done' ? 1 : 0), total: totalPortals }
      );
    });
    const sourceStatuses = [];
    const allCandidates = [];

    emitProgress('parsing', 'Parsing scraped data...');
    for (const snapshot of snapshots) {
      if (!snapshot.ok) {
        sourceStatuses.push(buildSourceStatus(snapshot, 0, 0, 'fetch_failed', snapshot.error || 'Fetch failed'));
        continue;
      }

      const candidates = extractDeterministicCandidates(snapshot);
      const verified = verifyCandidates(snapshot, candidates);
      allCandidates.push(...verified);
      sourceStatuses.push(buildSourceStatus(snapshot, candidates.length, verified.length, 'ok'));
    }

    // Fetch full titles for truncated EPADS tenders
    const truncatedEpads = allCandidates.filter(t =>
      t.source && t.source.includes('EPADS') && t.title && t.title.includes('...')
    );
    if (truncatedEpads.length > 0) {
      emitProgress('parsing', `Fetching full titles for ${truncatedEpads.length} EPADS tenders...`);
      await fetchEpadsTitles(truncatedEpads);
    }

    emitProgress('dedup', `Deduplicating ${allCandidates.length} tenders...`);
    const deduped = dedupeTenders(allCandidates);

    emitProgress('scoring', `Scoring ${deduped.length} tenders...`);
    for (const tender of deduped) {
      const heuristic = scoreTenderHeuristically(tender);
      tender.fitScore = heuristic.fitScore;
      tender.fitTags = heuristic.fitTags;
      tender.fitReason = heuristic.fitReason;
    }

    for (const tender of deduped) {
      tender.category = categorizeTender(tender);
    }

    emitProgress('pdf', 'Scanning PDF documents...');
    await deepScanPdfs(deduped);

    // AI enrichment: generate summaries, classify sectors, and refine scores
    const previousState = await readState();
    const previouslyEnrichedIds = new Set(
      (previousState.tenders || []).filter(t => t.aiSummary).map(t => t.id)
    );
    // Carry forward AI data from previous state for tenders that were already enriched
    const prevMap = new Map((previousState.tenders || []).map(t => [t.id, t]));
    const previouslyAnalyzedIds = new Set();
    for (const tender of deduped) {
      const prev = prevMap.get(tender.id);
      if (prev && prev.aiSummary) {
        tender.aiSummary = prev.aiSummary;
        tender.aiSector = prev.aiSector;
        tender.aiScore = prev.aiScore;
        tender.actionHint = prev.actionHint;
        // Re-blend scores
        if (tender.aiScore !== undefined) {
          tender.fitScore = Math.min(99, Math.round(tender.fitScore * 0.4 + tender.aiScore * 0.6));
        }
        if (tender.aiSector && tender.aiSector !== 'General' && !tender.sector) {
          tender.sector = tender.aiSector;
        }
      }
      // Carry forward PDF analysis
      if (prev && prev.pdfAnalysis) {
        tender.pdfAnalysis = prev.pdfAnalysis;
        previouslyAnalyzedIds.add(tender.id);
        // Restore overridden fields from deep analysis
        if (prev.pdfAnalysis.detailedSummary && prev.pdfAnalysis.detailedSummary.length > 20) {
          tender.aiSummary = prev.pdfAnalysis.detailedSummary.slice(0, 300);
        }
        if (prev.pdfAnalysis.relevanceFit || prev.pdfAnalysis.evrimFit) {
          tender.actionHint = (prev.pdfAnalysis.relevanceFit || prev.pdfAnalysis.evrimFit).slice(0, 200);
        }
      }
    }
    emitProgress('ai', 'AI enrichment (summaries & scoring)...');
    try {
      await enrichTendersWithAI(deduped, previouslyEnrichedIds);
    } catch (err) {
      console.error('[AI] Phase 1 failed (credits exhausted?):', err.message);
    }
    emitProgress('ai-pdf', 'AI deep PDF analysis...');
    try {
      await deepAnalyzePdfs(deduped, previouslyAnalyzedIds);
    } catch (err) {
      console.error('[AI] Phase 2 failed (credits exhausted?):', err.message);
    }

    // Preserve bookmarked tenders that weren't re-scraped (e.g. portal was down)
    // but NOT if they're expired — expired tenders always get removed
    const today = getTodayInKarachi();
    const allBookmarks = await readBookmarks();
    const allBookmarkedIds = new Set(Object.values(allBookmarks).flat());
    if (allBookmarkedIds.size > 0) {
      const newIds = new Set(deduped.map(t => t.id));
      for (const prev of (previousState.tenders || [])) {
        if (allBookmarkedIds.has(prev.id) && !newIds.has(prev.id) && isFutureOrToday(prev.closing, today)) {
          deduped.push(prev);
        }
      }
    }

    // Stamp firstSeenAt on new tenders, carry forward for existing ones
    const now = new Date().toISOString();
    for (const tender of deduped) {
      const prev = prevMap.get(tender.id);
      tender.firstSeenAt = (prev && prev.firstSeenAt) ? prev.firstSeenAt : now;
    }

    deduped.sort((a, b) => {
      const scoreDiff = Number(b.fitScore || 0) - Number(a.fitScore || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(a.closing || '9999-12-31') - new Date(b.closing || '9999-12-31');
    });

    const state = {
      meta: {
        appName: 'OpenTenders',
        verificationMode: 'deterministic-official-only',
        lastRefreshAt: new Date().toISOString(),
        lastRefreshType: manual ? 'manual' : 'scheduled',
        nextRefreshHint: 'Daily at 08:00 Asia/Karachi',
        totals: {
          tenders: deduped.length,
          sources: sourceStatuses.length
        }
      },
      sources: sourceStatuses,
      tenders: deduped
    };

    emitProgress('saving', 'Saving results...');
    await writeState(state);
    await archiveOldTenders();
    emitProgress('done', `Refresh complete — ${deduped.length} tenders from ${sourceStatuses.filter(s => s.status === 'ok').length} portals`);
    return state;
  })();

  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

function verifyCandidates(snapshot, candidates) {
  const today = getTodayInKarachi();

  return candidates
    .map((candidate) => normalizeTender(candidate, snapshot))
    .filter((candidate) => {
      if (!candidate.id || !candidate.title) return false;
      if (!candidate.sourceUrl || !isOfficialUrl(candidate.sourceUrl, snapshot.source)) return false;
      // EPADS listings don't include closing dates — they're on the detail page
      // So skip date check for EPADS (they only show active tenders anyway)
      // Global portals (World Bank) only show active notices — skip date check for them
      const skipDateCheck = ['epads-federal', 'world-bank'].includes(snapshot.source.id);
      if (!skipDateCheck && !isFutureOrToday(candidate.closing, today)) return false;
      if (!matchesSource(snapshot, candidate)) return false;
      // No keyword gate — show ALL tenders from official portals.
      // The fit score system ranks IT/software tenders higher so they appear first.
      return true;
    })
    .map((candidate) => ({
      ...candidate,
      title: smartTitle(candidate.title),
      verified: true,
      verifiedAt: new Date().toISOString(),
      verificationMethod: 'deterministic-source-parser'
    }));
}

function normalizeTender(candidate, snapshot) {
  const heuristic = scoreTenderHeuristically(candidate);
  return {
    id: clean(candidate.id),
    officialRef: clean(candidate.officialRef),
    title: clean(candidate.title),
    description: clean(candidate.description),
    organization: clean(candidate.organization),
    ministry: clean(candidate.ministry),
    province: clean(candidate.province) || snapshot.source.province,
    city: clean(candidate.city) || snapshot.source.city,
    type: clean(candidate.type) || 'Tender Notice',
    sector: clean(candidate.sector),
    referenceNumber: clean(candidate.referenceNumber),
    advertised: clean(candidate.advertised),
    closing: clean(candidate.closing),
    closingTime: clean(candidate.closingTime),
    status: clean(candidate.status) || 'Listed',
    source: clean(candidate.source) || snapshot.source.label,
    sourceUrl: clean(candidate.sourceUrl) || snapshot.sourceUrl || snapshot.source.sourceUrl,
    tenderNoticeUrl: clean(candidate.tenderNoticeUrl),
    biddingDocUrl: clean(candidate.biddingDocUrl),
    downloadUrl: clean(candidate.downloadUrl),
    evidenceText: clean(candidate.evidenceText),
    summary: buildSummary(candidate),
    fitScore: heuristic.fitScore,
    fitTags: heuristic.fitTags,
    fitReason: heuristic.fitReason,
    fetchedAt: snapshot.fetchedAt,
    fetchedFrom: snapshot.source.label
  };
}

function matchesSource(snapshot, candidate) {
  const rawText = normalize(snapshot.rawText);
  const candidateTitle = normalize(candidate.title);
  const reference = normalize(candidate.officialRef || candidate.referenceNumber || '');
  const org = normalize(candidate.organization);
  const closing = normalize(candidate.closing);

  if (snapshot.source.id === 'ppra-federal') {
    if (!reference || !rawText.includes(reference)) return false;
    if (candidateTitle && !softIncludes(rawText, candidateTitle)) return false;
    if (org && !softIncludes(rawText, org)) return false;
    return dateAppearsInText(candidate.closing, rawText);
  }

  if (snapshot.source.id === 'epads-federal') {
    // EPADS tenders: verify ref and title appear in page text
    if (!reference || !rawText.includes(reference.toLowerCase())) return false;
    if (candidateTitle && !softIncludes(rawText, candidateTitle)) return false;
    return true;
  }

  if (snapshot.source.id === 'moitt') {
    if (candidateTitle && !softIncludes(rawText, candidateTitle)) return false;
    if (closing && !dateAppearsInText(candidate.closing, rawText)) return false;
    return true;
  }

  if (snapshot.source.id === 'punjab-eproc') {
    if (candidateTitle && !softIncludes(rawText, candidateTitle)) return false;
    if (candidate.downloadUrl && !sameHost(snapshot.source.sourceUrl, candidate.downloadUrl)) return false;
    return dateAppearsInText(candidate.closing, rawText);
  }

  if (snapshot.source.id === 'kppra-kpk') {
    if (reference && !rawText.includes(reference)) return false;
    if (candidateTitle && !softIncludes(rawText, candidateTitle)) return false;
    return dateAppearsInText(candidate.closing, rawText);
  }

  if (snapshot.source.id === 'ajkppra') {
    if (reference && !rawText.includes(reference)) return false;
    if (candidateTitle && !softIncludes(rawText, candidateTitle)) return false;
    return dateAppearsInText(candidate.closing, rawText);
  }

  // Global portals — light verification: title must partially appear in raw text (or API data)
  if (snapshot.source.id === 'world-bank') {
    // API data is pre-verified — accept all valid candidates
    return true;
  }

  if (snapshot.source.id === 'bangladesh-cptu') {
    if (candidateTitle && rawText.length > 100 && !softIncludes(rawText, candidateTitle)) return false;
    return true;
  }

  if (snapshot.source.id === 'kenya-ppra') {
    if (candidateTitle && rawText.length > 100 && !softIncludes(rawText, candidateTitle)) return false;
    return true;
  }

  if (snapshot.source.id === 'afdb') {
    if (candidateTitle && rawText.length > 100 && !softIncludes(rawText, candidateTitle)) return false;
    return true;
  }

  return false;
}

function buildSourceStatus(snapshot, candidateCount, verifiedCount, status, error = '') {
  return {
    id: snapshot.source.id,
    label: snapshot.source.label,
    country: snapshot.source.country || 'Pakistan',
    flag: snapshot.source.flag || '🇵🇰',
    province: snapshot.source.province,
    sourceUrl: snapshot.source.sourceUrl,
    fetchedAt: snapshot.fetchedAt,
    pageUrl: snapshot.sourceUrl,
    title: snapshot.sourceTitle,
    ok: snapshot.ok,
    status,
    candidateCount,
    verifiedCount,
    error
  };
}

function dedupeTenders(tenders) {
  // Stage 1: Dedupe within same source (by ref or title + closing)
  const withinSource = new Map();
  for (const tender of tenders) {
    const key = `${normalize(tender.source)}::${normalize(tender.officialRef || tender.title)}::${tender.closing}`;
    if (!withinSource.has(key)) withinSource.set(key, tender);
  }
  const stage1 = Array.from(withinSource.values());

  // Stage 2: Dedupe across portals — same title (normalized) + same closing date
  // PPRA EPMS and EPADS v2 are the same federal system, so exact-title matches are real duplicates
  const crossPortal = new Map();
  for (const tender of stage1) {
    const normTitle = normalize(tender.title);
    const crossKey = `${normTitle}::${tender.closing}`;
    if (crossPortal.has(crossKey)) {
      // Keep the one with more data (has org, has download URL, has ref)
      const existing = crossPortal.get(crossKey);
      const existingScore = (existing.organization ? 1 : 0) + (existing.downloadUrl ? 1 : 0) + (existing.officialRef ? 1 : 0) + (existing.tenderNoticeUrl ? 1 : 0);
      const newScore = (tender.organization ? 1 : 0) + (tender.downloadUrl ? 1 : 0) + (tender.officialRef ? 1 : 0) + (tender.tenderNoticeUrl ? 1 : 0);
      if (newScore > existingScore) crossPortal.set(crossKey, tender);
    } else {
      crossPortal.set(crossKey, tender);
    }
  }

  return Array.from(crossPortal.values());
}

function dateAppearsInText(dateValue, text) {
  if (!dateValue) return false;
  const variants = dateVariants(dateValue).map(normalize).filter(Boolean);
  return variants.some((item) => text.includes(item));
}

function dateVariants(dateValue) {
  const match = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return [];
  const [, year, month, day] = match;
  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const monthNamesFull = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const monthName = monthNames[Number(month) - 1] || '';
  const monthFull = monthNamesFull[Number(month) - 1] || '';
  return [
    `${year}-${month}-${day}`,
    `${day}-${month}-${year}`,
    `${day}/${month}/${year}`,
    `${month}/${day}/${year}`,
    `${monthName} ${day}, ${year}`,
    `${monthName} ${Number(day)}, ${year}`,
    `${day} ${monthName} ${year}`,
    `${day} ${monthName}, ${year}`,
    `${monthFull} ${day}, ${year}`,
    `${monthFull} ${Number(day)}, ${year}`,
    `${day} ${monthFull} ${year}`,
    `${day} ${monthFull}, ${year}`,
    `${day}-${monthName}-${year}`,
    `${Number(day)}-${monthName}-${year}`
  ];
}

function sameHost(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

const OFFICIAL_HOSTS = new Set([
  // Pakistan portals
  'eproc.punjab.gov.pk', 'epms.ppra.gov.pk', 'epads.gov.pk', 'pa.epads.gov.pk',
  'moitt.gov.pk', 'www.kppra.gov.pk', 'kppra.gov.pk', 'bppqa.vdc.services',
  'www.ajkppra.gov.pk', 'ajkppra.gov.pk',
  // World Bank
  'search.worldbank.org', 'projects.worldbank.org', 'documents.worldbank.org',
  'worldbank.org', 'www.worldbank.org',
  // Bangladesh
  'www.cptu.gov.bd', 'cptu.gov.bd', 'eprocure.gov.bd',
  // Kenya
  'ppra.go.ke', 'www.ppra.go.ke', 'epp.ppra.go.ke',
  // AfDB
  'www.afdb.org', 'afdb.org'
]);

function isOfficialUrl(url, source) {
  // For API-sourced portals (World Bank), sourceUrl is the API — trust all results
  if (source && source.type === 'api') return true;
  // For global browser portals with no closing (e.g. AfDB anchor fallback), allow portal's own domain
  if (source && source.id === 'afdb' && (!url || url === source.sourceUrl)) return true;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

function isFutureOrToday(dateValue, today) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateValue || '') && dateValue >= today;
}

function getTodayInKarachi() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9\s:/,.-]/g, '').trim();
}

function softIncludes(haystack, needle) {
  const parts = needle.split(' ').filter(Boolean).slice(0, 10);
  return parts.length > 0 && parts.every((part) => haystack.includes(part));
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** Build a brief summary from evidence text, stripping the title and boilerplate */
function buildSummary(candidate) {
  const evidence = clean(candidate.evidenceText);
  const title = clean(candidate.title).toLowerCase();
  if (!evidence || evidence.length < 30) return '';

  // Remove the title from evidence to get extra info
  let text = evidence;
  // Remove common table column noise
  text = text.replace(/\b(tender|notice|download|action|view|details?|published|closing|opening|date|bidding|doc)\b/gi, ' ');
  text = text.replace(/\d{2}[-/]\d{2}[-/]\d{4}/g, ' '); // dates
  text = text.replace(/\d{2}[-/][a-z]{3}[-/]\d{4}/gi, ' '); // dates like 17-Mar-2026
  text = text.replace(/\s+/g, ' ').trim();

  // Extract meaningful phrases that aren't in the title
  const words = text.split(' ').filter(w => w.length > 2 && !title.includes(w.toLowerCase()));
  const summary = words.slice(0, 20).join(' ').trim();

  if (summary.length < 15) return '';
  // Cap at 150 chars
  return summary.length > 150 ? summary.slice(0, summary.lastIndexOf(' ', 150)) : summary;
}

const MAX_PDF_SCANS = 25;
const PDF_BATCH_SIZE = 8;

const EPADS_TITLE_BATCH = 15;
const EPADS_TITLE_TIMEOUT = 5000;

async function fetchEpadsTitles(tenders) {
  // For each truncated EPADS tender, fetch the detail page to find the SBD iframe,
  // then fetch the SBD page to extract the full title.
  // Carry forward previously resolved titles from the previous state.
  const previousState = await readState();
  const prevMap = new Map((previousState.tenders || []).map(t => [t.id, t]));
  const needsFetch = [];

  for (const t of tenders) {
    const prev = prevMap.get(t.id);
    if (prev && prev.title && !prev.title.includes('...')) {
      // Previous refresh already resolved this title
      t.title = smartTitle(prev.title);
    } else {
      needsFetch.push(t);
    }
  }

  if (!needsFetch.length) return;

  for (let i = 0; i < needsFetch.length; i += EPADS_TITLE_BATCH) {
    const batch = needsFetch.slice(i, i + EPADS_TITLE_BATCH);
    await Promise.allSettled(batch.map(async (tender) => {
      try {
        // Extract procurement ID from sourceUrl
        const idMatch = tender.sourceUrl && tender.sourceUrl.match(/procurements\/(\d+)/);
        if (!idMatch) return;

        // Fetch detail page to find SBD iframe URL
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), EPADS_TITLE_TIMEOUT);
        const detailRes = await fetch(tender.sourceUrl, { signal: controller.signal, redirect: 'follow' });
        clearTimeout(timeout);
        const detailHtml = await detailRes.text();

        // Find SBD iframe: src="https://pa.epads.gov.pk/procurement/goods/2308/sbd"
        const iframeMatch = detailHtml.match(/pa\.epads\.gov\.pk\/procurement\/[^"'\s]+\/sbd/);
        if (!iframeMatch) return;

        const sbdUrl = 'https://' + iframeMatch[0];
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), EPADS_TITLE_TIMEOUT);
        const sbdRes = await fetch(sbdUrl, { signal: controller2.signal, redirect: 'follow' });
        clearTimeout(timeout2);
        const sbdHtml = await sbdRes.text();

        // Extract title from h6 tags — skip "Standard Bidding Document" and "Ref#" headings
        const h6Matches = sbdHtml.match(/<h6[^>]*>[\s\S]*?<\/h6>/g);
        if (h6Matches) {
          for (const h6 of h6Matches) {
            const inner = h6.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (inner.length < 15) continue;
            if (/^(Standard Bidding|Ref#|SBD)/i.test(inner)) continue;
            const fullTitle = inner.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'").replace(/&quot;/g, '"').trim();
            if (fullTitle.length > tender.title.replace(/\.{3,}/g, '').trim().length) {
              tender.title = smartTitle(fullTitle);
              break;
            }
          }
        }
      } catch {
        // Timeout or network error — keep truncated title
      }
    }));
  }

  // Clean up remaining "..." — replace with clean ellipsis for display
  for (const t of tenders) {
    if (t.title && t.title.includes('...')) {
      t.title = t.title.replace(/\.{3,}\s*$/, '\u2026').replace(/\.{3,}/, '\u2026');
    }
  }
}

async function deepScanPdfs(tenders) {
  const eligible = tenders
    .filter(t => (t.fitScore || 0) > 20 && (t.downloadUrl || t.tenderNoticeUrl))
    .slice(0, MAX_PDF_SCANS);

  if (!eligible.length) return;

  // Process in batches to avoid overwhelming network
  for (let i = 0; i < eligible.length; i += PDF_BATCH_SIZE) {
    const batch = eligible.slice(i, i + PDF_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (tender) => {
        const url = tender.downloadUrl || tender.tenderNoticeUrl;
        const text = await extractPdfText(url);
        if (text) boostFromPdfContent(tender, text);
      })
    );
  }
}
