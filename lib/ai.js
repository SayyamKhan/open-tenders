/**
 * OpenTenders — AI Enrichment
 * Uses Claude API for:
 *  1. Metadata-based quick analysis (summaries, scoring, classification)
 *  2. Deep PDF document analysis (requirements, budget, eligibility, deadlines)
 * Only processes NEW tenders to save API credits.
 */
import Anthropic from '@anthropic-ai/sdk';
import { extractPdfText } from './pdf-utils.js';

const AI_BATCH_SIZE = 20;
const AI_MAX_TENDERS = 80;
const PDF_AI_MAX = 25;       // max tenders for deep PDF analysis per refresh
const PDF_AI_CONCURRENCY = 8; // concurrent PDF analyses
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 3;

// Track credit exhaustion across refreshes — avoids wasting calls once we know credits are gone
let creditExhausted = false;
let creditExhaustedAt = null;
const CREDIT_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000; // retry after 6 hours in case credits are topped up

let client = null;

function isCreditError(err) {
  const status = err?.status || err?.statusCode || 0;
  const msg = String(err?.message || '').toLowerCase();
  return status === 402 || msg.includes('credit') || msg.includes('quota');
}

function isRateLimitError(err) {
  const status = err?.status || err?.statusCode || 0;
  const msg = String(err?.message || '').toLowerCase();
  return status === 429 || msg.includes('rate_limit');
}

function isRetryableError(err) {
  const status = err?.status || err?.statusCode || 0;
  return isRateLimitError(err) || status === 500 || status === 502 || status === 503 || status === 529;
}

async function callWithRetry(fn) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isCreditError(err)) throw err; // don't retry credit exhaustion
      if (attempt === MAX_RETRIES || !isRetryableError(err)) throw err;
      // Exponential backoff: 2s, 4s, 8s — with jitter
      const backoff = Math.pow(2, attempt + 1) * 1000 + Math.random() * 1000;
      // Use retry-after header if available
      const retryAfter = err?.headers?.['retry-after'];
      const waitMs = retryAfter ? Math.min(Number(retryAfter) * 1000, 30000) : backoff;
      console.log(`[AI] Rate limited, retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

// ── Phase 1: Metadata-based enrichment (batched, cheap) ──────────────

function isCreditsAvailable() {
  if (!creditExhausted) return true;
  // Allow retry after CREDIT_RETRY_INTERVAL_MS in case user topped up credits
  if (creditExhaustedAt && (Date.now() - creditExhaustedAt) > CREDIT_RETRY_INTERVAL_MS) {
    console.log('[AI] Credit cooldown expired — retrying API calls');
    creditExhausted = false;
    creditExhaustedAt = null;
    return true;
  }
  return false;
}

function markCreditsExhausted() {
  creditExhausted = true;
  creditExhaustedAt = Date.now();
  console.warn('[AI] Credits exhausted — AI enrichment disabled until credits are topped up (will retry in 6h)');
}

export async function enrichTendersWithAI(tenders, previouslyEnrichedIds = new Set()) {
  const anthropic = getClient();
  if (!anthropic) {
    console.log('[AI] No ANTHROPIC_API_KEY — skipping (portal works fine without it)');
    return tenders;
  }

  if (!isCreditsAvailable()) {
    console.log('[AI] Credits previously exhausted — skipping Phase 1 (portal works fine without it)');
    return tenders;
  }

  const needsEnrichment = tenders.filter(t => !previouslyEnrichedIds.has(t.id) && !t.aiSummary);
  if (!needsEnrichment.length) {
    console.log('[AI] All tenders already enriched — skipping metadata phase');
    return tenders;
  }

  const toProcess = needsEnrichment.slice(0, AI_MAX_TENDERS);
  console.log(`[AI] Phase 1: Enriching ${toProcess.length} tenders (metadata)...`);

  for (let i = 0; i < toProcess.length; i += AI_BATCH_SIZE) {
    const batch = toProcess.slice(i, i + AI_BATCH_SIZE);
    try {
      await enrichBatch(anthropic, batch);
      console.log(`[AI] Metadata batch ${Math.floor(i / AI_BATCH_SIZE) + 1} done (${batch.length} tenders)`);
    } catch (err) {
      console.error(`[AI] Metadata batch failed:`, err.message);
      if (isCreditError(err)) { markCreditsExhausted(); break; }
    }
  }

  return tenders;
}

async function enrichBatch(anthropic, batch) {
  const tendersForPrompt = batch.map((t, i) => ({
    idx: i,
    title: t.title,
    description: t.description || '',
    organization: t.organization,
    ministry: t.ministry || '',
    province: t.province,
    type: t.type,
    sector: t.sector || '',
    evidence: (t.evidenceText || '').slice(0, 400)
  }));

  const response = await callWithRetry(() => anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are an expert government procurement analyst for OpenTenders, a global procurement intelligence platform.

Analyze these ${batch.length} government tenders. For EACH return:
1. **summary**: A clear, specific 1-2 sentence description that answers: WHAT is being procured? WHO is buying it? WHAT is the scope? Avoid vague language like "various items" or "procurement services". Name the actual items/systems/services. If the title is unclear, use the description and evidence fields to figure out what's actually being bought.
2. **sector**: One of: "IT Hardware", "Digital Platforms", "Surveillance", "Consultancy", "Networking", "Cybersecurity", "Healthcare", "Finance & Banking", "Construction", or "General".
3. **aiScore**: 0-100 relevance for IT/tech companies. 70+ = strong IT fit, 30-69 = partial, 0-29 = not IT.
4. **actionHint**: One actionable sentence for a business development team evaluating this opportunity.

IMPORTANT: The summary must be specific enough that someone can tell EXACTLY what the tender is about without clicking into it. Bad: "Procurement of IT equipment for a government department." Good: "Supply and installation of 200 desktop computers with monitors, UPS units, and networking equipment for Punjab Revenue Authority offices in Lahore."

Return ONLY a JSON array: [{idx, summary, sector, aiScore, actionHint}]. No markdown.

Tenders:
${JSON.stringify(tendersForPrompt, null, 2)}`
    }]
  }));

  const text = response.content[0]?.text || '';
  let results;
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array');
    results = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[AI] Parse failed:', e.message, text.slice(0, 300));
    return;
  }

  for (const r of results) {
    const tender = batch[r.idx];
    if (!tender) continue;
    tender.aiSummary = String(r.summary || '').slice(0, 300);
    tender.aiSector = String(r.sector || '').slice(0, 50);
    tender.aiScore = Math.max(0, Math.min(100, Number(r.aiScore) || 0));
    tender.actionHint = String(r.actionHint || '').slice(0, 200);

    // Blend scores: AI 60%, heuristic 40%
    if (tender.fitScore !== undefined) {
      tender.fitScore = Math.min(99, Math.round(tender.fitScore * 0.4 + tender.aiScore * 0.6));
    }
    if (tender.aiSector && tender.aiSector !== 'General' && !tender.sector) {
      tender.sector = tender.aiSector;
    }
  }
}

// ── Phase 2: Deep PDF analysis (per-tender, richer) ──────────────────

export async function deepAnalyzePdfs(tenders, previouslyAnalyzedIds = new Set()) {
  const anthropic = getClient();
  if (!anthropic) return tenders;

  if (!isCreditsAvailable()) {
    console.log('[AI] Credits previously exhausted — skipping Phase 2 PDF analysis');
    return tenders;
  }

  // Only analyze high-scoring tenders with PDFs that haven't been analyzed
  const eligible = tenders.filter(t =>
    !previouslyAnalyzedIds.has(t.id) &&
    !t.pdfAnalysis &&
    (t.fitScore || 0) >= 25 &&
    (t.downloadUrl || t.tenderNoticeUrl)
  );

  if (!eligible.length) {
    console.log('[AI] No new PDFs to analyze');
    return tenders;
  }

  // Sort by score desc — analyze most relevant first
  eligible.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
  const toAnalyze = eligible.slice(0, PDF_AI_MAX);
  console.log(`[AI] Phase 2: Deep-analyzing ${toAnalyze.length} tender PDFs...`);

  // Process with limited concurrency
  for (let i = 0; i < toAnalyze.length; i += PDF_AI_CONCURRENCY) {
    const batch = toAnalyze.slice(i, i + PDF_AI_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(tender => analyzeSinglePdf(anthropic, tender))
    );
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const creditFail = results.some(r => r.status === 'rejected' && isCreditError(r.reason));
    console.log(`[AI] PDF batch ${Math.floor(i / PDF_AI_CONCURRENCY) + 1}: ${succeeded}/${batch.length} analyzed`);
    if (creditFail) { markCreditsExhausted(); break; }
  }

  return tenders;
}

async function analyzeSinglePdf(anthropic, tender) {
  const url = tender.downloadUrl || tender.tenderNoticeUrl;
  const pdfText = await extractPdfText(url);
  if (!pdfText || pdfText.length < 100) return;

  // Use first 3500 chars (scope/overview) + last 2500 chars (budget/contact info often at end)
  const truncated = pdfText.length <= 6000 ? pdfText
    : pdfText.slice(0, 3500) + '\n...\n' + pdfText.slice(-2500);

  const response = await callWithRetry(() => anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are analyzing a government tender document for OpenTenders, a global procurement intelligence platform.

Extract the following from this tender document. If info is not found, use null.

Return ONLY JSON (no markdown):
{
  "detailedSummary": "2-3 sentence detailed summary of scope of work",
  "requirements": ["list of key technical/qualification requirements, max 5 items"],
  "estimatedBudget": "budget amount if mentioned, or null",
  "eligibility": "key eligibility criteria in 1 sentence, or null",
  "submissionMethod": "how to submit (online/physical/both) + where, or null",
  "bidSecurity": "bid security/earnest money amount if mentioned, or null",
  "contactInfo": "contact person/phone/email if found, or null",
  "relevanceFit": "1 sentence on how relevant this is for IT/tech companies bidding"
}

Tender title: ${tender.title}
Organization: ${tender.organization}

Document text:
${truncated}`
    }]
  }));

  const text = response.content[0]?.text || '';
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const analysis = JSON.parse(jsonMatch[0]);

    tender.pdfAnalysis = {
      detailedSummary: String(analysis.detailedSummary || '').slice(0, 500),
      requirements: Array.isArray(analysis.requirements) ? analysis.requirements.map(r => String(r).slice(0, 150)).slice(0, 5) : [],
      estimatedBudget: analysis.estimatedBudget ? String(analysis.estimatedBudget).slice(0, 100) : null,
      eligibility: analysis.eligibility ? String(analysis.eligibility).slice(0, 300) : null,
      submissionMethod: analysis.submissionMethod ? String(analysis.submissionMethod).slice(0, 200) : null,
      bidSecurity: analysis.bidSecurity ? String(analysis.bidSecurity).slice(0, 100) : null,
      contactInfo: analysis.contactInfo ? String(analysis.contactInfo).slice(0, 200) : null,
      relevanceFit: analysis.relevanceFit ? String(analysis.relevanceFit).slice(0, 200) : null,
      analyzedAt: new Date().toISOString()
    };

    // Override summary with deeper one if available
    if (analysis.detailedSummary && analysis.detailedSummary.length > 20) {
      tender.aiSummary = String(analysis.detailedSummary).slice(0, 300);
    }
    // Override action hint with relevanceFit
    const fitText = analysis.relevanceFit;
    if (fitText) {
      tender.actionHint = String(fitText).slice(0, 200);
    }
  } catch (e) {
    console.error(`[AI] PDF parse failed for ${tender.id}:`, e.message);
  }
}
