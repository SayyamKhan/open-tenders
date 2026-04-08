import { config } from './config.js';

// Pre-compile keyword regexes at module load — avoids creating hundreds of RegExp objects per call
const _keywordRegexCache = new Map();
function getKeywordRegex(keyword) {
  let rx = _keywordRegexCache.get(keyword);
  if (!rx) {
    rx = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    _keywordRegexCache.set(keyword, rx);
  }
  return rx;
}

// Pre-compile the bonus score regexes (called on every tender)
const BONUS_HARDWARE = /\b(?:laptop|it equipment|server|network|vpn|hardware|computer|router|printer|ups)\b/;
const BONUS_SOFTWARE = /\b(?:software|platform|portal|digital|ict|erp|mis|database|cloud|hosting|website)\b/;
const BONUS_CONSULT  = /\b(?:it consultancy|it audit|cybersecurity)\b/;
const BONUS_SURVEIL  = /\b(?:cctv|camera|surveillance|smart city|parking|e-challan)\b/;

const PPRA_SECTORS = [
  'Ammunition', 'Appliances', 'Books/Journals/Manuals(Technical/Literature)', 'Chemical Items', 'Civil Goods',
  'Civil Works', 'Clothing/Uniform', 'Consumable Items', 'Electrical Items', 'Equipments', 'Food Items',
  'Furniture/Fixture', 'Health/Medicines', 'Info and Comm Tech', 'Leasing', 'Lubricants/Oils',
  'Mechanical/Machinery', 'Mining', 'Miscellaneous', 'Printing', 'Repair/Maintenance', 'Research & Development',
  'Services', 'Stationery', 'Vehicles'
];

export function extractDeterministicCandidates(snapshot) {
  switch (snapshot.source.id) {
    case 'ppra-federal':
      return parsePpra(snapshot);
    case 'epads-federal':
      return parseEpads(snapshot);
    case 'moitt':
      return parseMoitt(snapshot);
    case 'punjab-eproc':
      return parsePunjab(snapshot);
    case 'kppra-kpk':
      return parseKppra(snapshot);
    case 'ajkppra':
      return parseAjkppra(snapshot);
    case 'world-bank':
      return parseWorldBank(snapshot);
    case 'bangladesh-cptu':
      return parseBangladeshCptu(snapshot);
    case 'kenya-ppra':
      return parseKenyaPpra(snapshot);
    case 'afdb':
      return parseAfdb(snapshot);
    default:
      return [];
  }
}

export function scoreTenderHeuristically(tender) {
  // Exclude sector from haystack to avoid feedback loop (inferSector assigns "Digital Platforms" etc.)
  const haystack = normalize([
    tender.title,
    tender.organization,
    tender.type,
    tender.referenceNumber
  ].join(' '));

  const matched = config.evrimKeywords.filter((keyword) => getKeywordRegex(normalize(keyword)).test(haystack));
  let score = Math.min(85, matched.length * 14);

  if (BONUS_HARDWARE.test(haystack)) score += 12;
  if (BONUS_SOFTWARE.test(haystack)) score += 18;
  if (BONUS_CONSULT.test(haystack)) score += 8;
  if (BONUS_SURVEIL.test(haystack)) score += 14;

  score = Math.min(99, score);

  return {
    fitScore: score,
    fitTags: matched.slice(0, 6),
    fitReason: matched.length
      ? `Matched relevance keywords: ${matched.slice(0, 6).join(', ')}`
      : 'Low direct keyword overlap with IT/tech scope'
  };
}

const PDF_DEEP_KEYWORDS = [
  'react', 'angular', 'vue', 'node', 'python', 'java', 'php', '.net',
  'cisco', 'juniper', 'huawei', 'mikrotik', 'fortinet',
  'fiber', 'fibre', 'erp', 'sap', 'oracle', 'microsoft', 'aws', 'azure', 'gcp',
  'linux', 'windows server', 'vmware', 'docker', 'kubernetes',
  'postgresql', 'mysql', 'mongodb', 'sql server',
  'api', 'rest', 'microservices', 'devops', 'ci/cd',
  'firewall', 'ids', 'ips', 'siem', 'penetration testing',
  'active directory', 'ldap', 'ssl', 'tls',
  'data warehouse', 'etl', 'power bi', 'tableau',
  'scada', 'plc', 'iot', 'mqtt'
];

/**
 * Auto-categorize a tender based on its title, organization, sector, and type.
 * Returns one of the predefined categories for filtering in the UI.
 */
export function categorizeTender(tender) {
  const hay = [tender.title, tender.organization, tender.sector, tender.type, tender.aiSector]
    .filter(Boolean).join(' ').toLowerCase();

  // Order matters — more specific categories first
  if (/\b(?:cctv|camera|surveillance|nvr|dvr|ip camera|smart city|parking|e-challan|traffic management|security system|alarm|metal detector|baggage scanner)\b/.test(hay)) return 'Surveillance & Security';
  if (/\b(?:software|web|portal|erp|mis|gis|cms|crm|database|cloud|hosting|digitization|e-governance|saas|api|mobile app|android|ios|web application|custom software|enterprise software|devops|microservices|containerization|digital platform|ict)\b/.test(hay)) return 'IT & Software';
  if (/\b(?:hardware|laptop|computer|desktop|printer|scanner|projector|led display|biometric|rfid|server rack|blade server|nas|san|thin client|workstation|ups|photocopier|copier|it equipment)\b/.test(hay)) return 'Hardware & Equipment';
  if (/\b(?:network|vpn|router|switch|fiber|fibre|broadband|wifi|lan|wan|server|data center|telecom|telecommunication|cabling|structured cabling|optical fiber|bandwidth|connectivity|pabx|telephone|pbx|ip phone)\b/.test(hay)) return 'Networking & Telecom';
  if (/\b(?:health|hospital|medical|hms|emr|ehr|telemedicine|telehealth|pharmacy|pacs|vaccine|immunization|ambulance|surgical|icu|ventilator|oxygen|clinical|diagnostic|blood bank|sehat|his|lims|biomedical|autoclave|sterilization|nutrition|maternal|epidemiology|medicine)\b/.test(hay)) return 'Healthcare';
  if (/\b(?:fintech|banking|payment|wallet|aml|kyc|core banking|payment gateway|pos|atm|remittance|lending|insurance|microfinance|treasury|financial|accounting|billing|revenue|tax|e-payment|payroll|invoicing|credit scoring|fraud detection|settlement|budget)\b/.test(hay)) return 'Finance & Banking';
  if (/\b(?:construction|civil works|civil goods|building|road|bridge|dam|infrastructure|renovation|repair|maintenance|plumbing|electrical works|masonry|concrete|steel|earthwork)\b/.test(hay)) return 'Construction & Civil';
  if (/\b(?:consultancy|it consultancy|it audit|cybersecurity|information security|audit|validation|consulting|advisory|feasibility|study|assessment|evaluation)\b/.test(hay)) return 'Consulting & Services';
  if (/\b(?:education|school|university|college|training|lms|learning management|e-learning|computer lab|it lab|steam lab|maker space|smart board|interactive board)\b/.test(hay)) return 'Education';
  if (/\b(?:food|ration|catering|mess|kitchen|cooking|grocery|wheat|rice|flour|sugar|oil|ghee|milk|meat|vegetable|fruit)\b/.test(hay)) return 'Food & Supplies';
  if (/\b(?:vehicle|car|bus|truck|ambulance|motorcycle|transport|generator|fuel|petrol|diesel|lubricant|tyre|tire)\b/.test(hay)) return 'Vehicles & Transport';
  if (/\b(?:furniture|fixture|office|stationery|printing|paper|uniform|clothing|linen|bedding)\b/.test(hay)) return 'Office & Furniture';
  if (/\b(?:solar|energy|power|renewable|inverter|battery|transformer|electricity)\b/.test(hay)) return 'Energy & Power';
  if (/\b(?:automation|ai|artificial intelligence|machine learning|blockchain|iot|internet of things|data warehouse|big data|business intelligence|analytics|monitoring|dashboard)\b/.test(hay)) return 'Emerging Tech';

  // Fallback: check PPRA sector field
  const sector = (tender.sector || '').toLowerCase();
  if (sector.includes('info and comm tech')) return 'IT & Software';
  if (sector.includes('health') || sector.includes('medicine')) return 'Healthcare';
  if (sector.includes('civil works') || sector.includes('civil goods')) return 'Construction & Civil';
  if (sector.includes('equipment')) return 'Hardware & Equipment';
  if (sector.includes('vehicle')) return 'Vehicles & Transport';
  if (sector.includes('food')) return 'Food & Supplies';
  if (sector.includes('furniture') || sector.includes('stationery') || sector.includes('printing')) return 'Office & Furniture';
  if (sector.includes('electrical')) return 'Energy & Power';
  if (sector.includes('services')) return 'Consulting & Services';

  return 'General';
}

export function boostFromPdfContent(tender, pdfText) {
  if (!pdfText) return;
  const hay = pdfText.toLowerCase();
  const existingTags = new Set((tender.fitTags || []).map(t => t.toLowerCase()));

  const newMatches = PDF_DEEP_KEYWORDS.filter(kw => {
    if (existingTags.has(kw)) return false;
    try {
      return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay);
    } catch {
      return hay.includes(kw);
    }
  });

  if (!newMatches.length) return;

  const boost = Math.min(30, newMatches.length * 8);
  tender.fitScore = Math.min(99, (tender.fitScore || 0) + boost);
  tender.fitTags = [...(tender.fitTags || []), '[PDF Match]'].slice(0, 8);
  tender.pdfKeywords = newMatches.slice(0, 10);
  tender.fitReason = (tender.fitReason || '') + ` | PDF deep-scan matched: ${newMatches.slice(0, 5).join(', ')}`;
}

/**
 * Scan a header row's cells and build a column index map.
 * `mappings` is an object like { fieldName: ['keyword1', 'keyword2'] }.
 * Returns { fieldName: columnIndex } or null if no header row detected.
 */
function buildColumnMap(cells, mappings) {
  const map = {};
  let matchCount = 0;
  for (let i = 0; i < cells.length; i++) {
    const cellText = cells[i].toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    for (const [field, keywords] of Object.entries(mappings)) {
      if (map[field] !== undefined) continue;
      if (keywords.some(kw => cellText.includes(kw))) {
        map[field] = i;
        matchCount++;
        break;
      }
    }
  }
  // Require at least 3 field matches to consider it a valid header
  return matchCount >= 3 ? map : null;
}

function detectHeaderRow(tableRows, mappings, minCells) {
  for (let i = 0; i < Math.min(5, tableRows.length); i++) {
    const row = tableRows[i];
    if (row.cells.length < minCells) continue;
    const map = buildColumnMap(row.cells, mappings);
    if (map) return { headerIndex: i, columnMap: map };
  }
  return null;
}

function matchWholeWord(haystack, keyword) {
  // Use word boundary regex to avoid substring matches (e.g. "app" in "harappa")
  try {
    return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack);
  } catch {
    return haystack.includes(keyword);
  }
}

function parsePpra(snapshot) {
  const candidates = [];

  const PPRA_HEADER_MAP = {
    sr: ['sr', 's.no', 'no', '#'],
    tenderId: ['tender', 'tender no', 'tse'],
    details: ['detail', 'description', 'name', 'subject'],
    org: ['organization', 'org', 'department', 'agency', 'procuring'],
    status: ['status'],
    advertised: ['advertised', 'published', 'start', 'opening'],
    closing: ['closing', 'end', 'deadline', 'last date']
  };

  // Try dynamic header detection
  const allRows = snapshot.tableRows.filter((row) => row.cells.length >= 5);
  const headerResult = detectHeaderRow(allRows, PPRA_HEADER_MAP, 5);

  // Table approach: PPRA renders as a table with 7 columns
  const tableRows = snapshot.tableRows.filter((row) => row.cells.length >= 7);
  for (const row of tableRows) {
    let tenderId, detailsCell, orgCell, status, advertisedCell, closingCell;
    if (headerResult) {
      const cm = headerResult.columnMap;
      tenderId = row.cells[cm.tenderId ?? 1] || '';
      detailsCell = row.cells[cm.details ?? 2] || '';
      orgCell = row.cells[cm.org ?? 3] || '';
      status = row.cells[cm.status ?? 4] || '';
      advertisedCell = row.cells[cm.advertised ?? 5] || '';
      closingCell = row.cells[cm.closing ?? 6] || '';
    } else {
      [, tenderId, detailsCell, orgCell, status, advertisedCell, closingCell] = row.cells;
    }
    const idMatch = clean(tenderId).match(/^(TS[0-9A-Z]+E)$/i);
    if (!idMatch) continue;

    const id = idMatch[1].toUpperCase();
    // Prefer the heading text (bold/strong) within the cell — it's the real title
    const headingTitle = row.cellHeadings?.[2] || '';
    const rawTitle = headingTitle || parsePpraTitle(detailsCell);
    const title = trimTitle(dedupeRepeatedPhrase(rawTitle));
    const sector = parsePpraSector(detailsCell);
    const referenceNumber = parsePpraReference(detailsCell, sector);
    const orgParsed = parsePpraOrgCell(orgCell);
    const closingParsed = parsePpraClosing(closingCell);
    const detailLink = row.links.find((l) => /tender-details/i.test(l.href || ''));

    if (!title) continue;

    // Build a human-readable description from the full details cell
    const description = buildDescription({
      rawDetail: clean(detailsCell),
      title,
      org: orgParsed.organization,
      sector,
      type: inferTypeFromTitle(title)
    });

    candidates.push({
      id,
      officialRef: id,
      title,
      description,
      organization: orgParsed.organization,
      ministry: orgParsed.ministry || snapshot.source.label,
      province: snapshot.source.province,
      city: orgParsed.city || snapshot.source.city,
      type: inferTypeFromTitle(title),
      sector,
      referenceNumber,
      advertised: normalizeDate(advertisedCell),
      closing: closingParsed.date,
      closingTime: closingParsed.time,
      status: clean(status) || 'Published',
      source: snapshot.source.label,
      sourceUrl: detailLink?.href || snapshot.sourceUrl || snapshot.source.sourceUrl,
      downloadUrl: '',
      evidenceText: [id, title, orgParsed.organization, normalizeDate(advertisedCell), closingParsed.date].filter(Boolean).join(' | ')
    });
  }

  // Fallback: text-line approach for older page layouts
  if (!candidates.length) {
    const lines = toLines(snapshot.rawText);
    for (let i = 0; i < lines.length; i += 1) {
      const lineIdMatch = lines[i].match(/^(?:\d+\s+)?(TS[0-9A-Z]+E)$/i);
      if (!lineIdMatch) continue;

      const lid = lineIdMatch[1].toUpperCase();
      const ltitle = dedupeRepeatedPhrase(lines[i + 1] || '');
      const sectorAndRef = lines[i + 2] || '';
      const ministry = clean(lines[i + 3] || '');
      const detailLine = lines[i + 4] || '';

      const detail = parsePpraDetailLine(detailLine, ministry);
      const lsector = parsePpraSector(sectorAndRef);
      const lref = removeKnownPrefix(sectorAndRef, lsector).trim();

      if (!ltitle || !detail.organization || !detail.closing) continue;

      const ldescription = buildDescription({
        rawDetail: [ltitle, sectorAndRef, ministry, detailLine].filter(Boolean).join(' '),
        title: ltitle,
        org: detail.organization,
        sector: lsector,
        type: inferTypeFromTitle(ltitle)
      });

      candidates.push({
        id: lid,
        officialRef: lid,
        title: ltitle,
        description: ldescription,
        organization: detail.organization,
        ministry: ministry || detail.ministry || snapshot.source.label,
        province: snapshot.source.province,
        city: detail.city || snapshot.source.city,
        type: inferTypeFromTitle(ltitle),
        sector: lsector,
        referenceNumber: lref,
        advertised: detail.advertised,
        closing: detail.closing,
        closingTime: detail.closingTime,
        status: detail.status || 'Published',
        source: snapshot.source.label,
        sourceUrl: snapshot.sourceUrl || snapshot.source.sourceUrl,
        downloadUrl: '',
        evidenceText: [lid, ltitle, detail.organization, detail.advertised, detail.closing].filter(Boolean).join(' | ')
      });
    }
  }

  return candidates;
}

function parseEpads(snapshot) {
  // EPADS (epads.gov.pk) table: [#, Ref, Title+Closing, Type, Action]
  // Build a map of ref→full title from page anchors (they often have the untruncated title)
  const anchorTitles = new Map();
  for (const a of (snapshot.anchors || [])) {
    const refMatch = a.href && a.href.match(/procurements\/(\d+)/i);
    if (refMatch && a.text && a.text.length > 15 && !a.text.match(/^(view|download|detail)/i)) {
      const ref = 'P' + refMatch[1];
      const existing = anchorTitles.get(ref);
      if (!existing || a.text.length > existing.length) {
        anchorTitles.set(ref, clean(a.text));
      }
    }
  }
  const allRows = snapshot.tableRows.filter((row) => row.cells.length >= 3);
  const candidates = [];

  for (const row of allRows) {
    const cells = row.cells;
    // Skip header row
    if (cells[0] === '#' || cells[0] === 'S.No' || /^\s*$/.test(cells[0])) continue;
    // First cell is row number, second is ref like P12809
    const ref = clean(cells[1] || '');
    if (!/^P\d+$/i.test(ref)) continue;

    // Title is in cell[2], may include "Closing Time: ..." text
    let titleRaw = clean(cells[2] || '');
    // EPADS portal truncates long titles with "..." — try alternatives
    if (titleRaw.includes('...')) {
      // 1. Try link text (often has full title)
      const linkWithFullTitle = row.links.find(l => l.text && l.text.length > 10 && !l.text.match(/^(view|download|detail|action|#)/i));
      if (linkWithFullTitle && linkWithFullTitle.text.length > titleRaw.replace(/Closing\s+Time:.*/i, '').trim().length) {
        titleRaw = clean(linkWithFullTitle.text);
      }
      // 2. Try row.text which may have the full title before truncation
      if (titleRaw.includes('...') && row.text) {
        const rowText = clean(row.text);
        // Extract from row text: everything before "Closing Time" or the ref
        const beforeClosing = rowText.replace(/Closing\s+Time:.*/i, '').replace(/P\d{4,}\s*$/i, '').trim();
        // Remove row number prefix
        const withoutNum = beforeClosing.replace(/^\d+\s+P\d+\s+/i, '').replace(/^\d+\s+/, '').trim();
        if (withoutNum.length > titleRaw.replace(/Closing\s+Time:.*/i, '').trim().length && !withoutNum.includes('...')) {
          titleRaw = withoutNum;
        }
      }
      // 3. Try anchor title map (built from all page anchors with procurement refs)
      if (titleRaw.includes('...') && anchorTitles.has(ref)) {
        const anchorTitle = anchorTitles.get(ref);
        if (anchorTitle.length > titleRaw.replace(/Closing\s+Time:.*/i, '').trim().length) {
          titleRaw = anchorTitle;
        }
      }
    }
    // Extract closing info if present
    const closingMatch = titleRaw.match(/Closing\s+(?:Time|Date)?:?\s*(.+?)(?:\||Opening|$)/i);
    // Clean title by removing closing/opening time info
    const title = titleRaw.replace(/\n.*$/s, '').replace(/Closing\s+Time:.*/i, '').trim();

    // Parse closing date/time from the matched string
    let closingDate = '';
    let closingTime = '';
    if (closingMatch && closingMatch[1]) {
      const raw = closingMatch[1].trim();
      // Format: "Wednesday, April 1, 2026 11:00 AM" or similar
      const parsed = new Date(raw);
      if (!isNaN(parsed.getTime())) {
        closingDate = parsed.toISOString().slice(0, 10);
        const hh = parsed.getHours();
        const mm = parsed.getMinutes();
        closingTime = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      } else {
        // Fallback: try to extract date parts manually
        const dateMatch = raw.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/);
        if (dateMatch) {
          const fallback = new Date(`${dateMatch[1]} ${dateMatch[2]}, ${dateMatch[3]}`);
          if (!isNaN(fallback.getTime())) closingDate = fallback.toISOString().slice(0, 10);
        }
        const timeMatch = raw.match(/(\d{1,2}:\d{2})\s*(AM|PM)/i);
        if (timeMatch) closingTime = timeMatch[1] + ' ' + timeMatch[2];
      }
    }

    const type = clean(cells[3] || '');

    // Extract detail link
    const detailLink = row.links.find((l) => l.href && /epads\.gov\.pk.*procurements/i.test(l.href));
    const sourceUrl = detailLink?.href || `https://epads.gov.pk/opportunities/federal/procurements/${ref.replace(/^P/i, '')}`;

    if (!title) continue;

    const eDescription = buildDescription({
      rawDetail: clean(cells[2] || ''),
      title: trimTitle(title),
      org: '',
      sector: inferSector([title, type].join(' ')),
      type: type || inferTypeFromTitle(title)
    });

    candidates.push({
      id: `EPADS-${ref}`,
      officialRef: ref,
      title: trimTitle(title),
      description: eDescription,
      organization: '',
      ministry: '',
      province: snapshot.source.province,
      city: snapshot.source.city,
      type: type || inferTypeFromTitle(title),
      sector: inferSector([title, type].join(' ')),
      referenceNumber: ref,
      advertised: '',
      closing: closingDate,
      closingTime: closingTime,
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl,
      tenderNoticeUrl: '',
      biddingDocUrl: '',
      downloadUrl: '',
      evidenceText: row.text || cells.join(' | ')
    });
  }

  return candidates;
}

function parseMoitt(snapshot) {
  const MOITT_HEADER_MAP = {
    sr: ['sr', 's.no', 'no', '#'],
    title: ['title', 'description', 'detail', 'name', 'subject'],
    startDate: ['start date', 'start', 'published', 'opening', 'advertised'],
    endDate: ['end date', 'end', 'closing', 'deadline', 'last date']
  };

  const allRows = snapshot.tableRows.filter((row) => row.cells.length >= 4);
  const headerResult = detectHeaderRow(allRows, MOITT_HEADER_MAP, 3);
  const candidates = [];

  for (const row of allRows) {
    let srNo, title, startDate, endDate;
    if (headerResult) {
      const cm = headerResult.columnMap;
      srNo = row.cells[cm.sr ?? 0] || '';
      title = row.cells[cm.title ?? 1] || '';
      startDate = row.cells[cm.startDate ?? 2] || '';
      endDate = row.cells[cm.endDate ?? 3] || '';
    } else {
      [srNo, title, startDate, endDate] = row.cells;
    }
    if (!/^\d+$/.test(clean(srNo))) continue;
    if (!clean(title)) continue;

    const detailLink = row.links.find((l) => /TenderDetail/i.test(l.href || ''));
    const downloadLink = row.links.find((l) => /\.pdf$/i.test(l.href || '') || /SiteImage/i.test(l.href || ''));

    const mDescription = buildDescription({
      rawDetail: clean(title),
      title: trimTitle(title),
      org: 'Ministry of Information Technology & Telecommunication',
      sector: inferSector(title),
      type: inferTypeFromTitle(title)
    });

    candidates.push({
      id: `MOITT-${clean(srNo)}-${normalizeDate(endDate) || normalizeDate(startDate) || 'undated'}`,
      officialRef: '',
      title: trimTitle(title),
      description: mDescription,
      organization: 'Ministry of Information Technology & Telecommunication',
      ministry: 'Ministry of IT and Telecom',
      province: snapshot.source.province,
      city: snapshot.source.city,
      type: inferTypeFromTitle(title),
      sector: inferSector(title),
      referenceNumber: '',
      advertised: normalizeDate(startDate),
      closing: normalizeDate(endDate),
      closingTime: '',
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl: detailLink?.href || row.links[0]?.href || snapshot.sourceUrl || snapshot.source.sourceUrl,
      downloadUrl: downloadLink?.href || '',
      evidenceText: row.text || row.cells.join(' | ')
    });
  }

  return candidates;
}

function parseKppra(snapshot) {
  // KPPRA has a table: [Tender No, Description, Procurement Entity, Date of Ad, Closing Date, Tender/EOI, Bidding Docs, Action]
  const KPPRA_HEADER_MAP = {
    tenderNo: ['tender no', 'tender', 'ref', 'no', 'sr'],
    title: ['description', 'detail', 'name', 'subject'],
    org: ['procurement entity', 'entity', 'organization', 'department', 'procuring'],
    advertised: ['date of ad', 'advertised', 'published', 'start', 'opening'],
    closing: ['closing date', 'closing', 'end', 'deadline', 'last date']
  };

  const allRows = snapshot.tableRows.filter((row) => row.cells.length >= 5);
  const headerResult = detectHeaderRow(allRows, KPPRA_HEADER_MAP, 5);
  const candidates = [];

  for (const row of allRows) {
    const cells = row.cells;
    let tenderNo, title, organization, advertised, closing;
    if (headerResult) {
      const cm = headerResult.columnMap;
      tenderNo = clean(cells[cm.tenderNo ?? 0] || '');
      title = clean(cells[cm.title ?? 1] || '');
      organization = clean(cells[cm.org ?? 2] || '');
      advertised = normalizeDate(cells[cm.advertised ?? 3] || '');
      closing = normalizeDate(cells[cm.closing ?? 4] || '');
    } else {
      tenderNo = clean(cells[0]);
      title = clean(cells[1]);
      organization = clean(cells[2]);
      advertised = normalizeDate(cells[3]);
      closing = normalizeDate(cells[4]);
    }
    if (!/^\d+$/.test(tenderNo)) continue;

    if (!title || !closing) continue;

    // Find detail/action link (KPPRA has an "Action" column with view link)
    // Look for any non-PDF link that could be detail/action — exclude force_download and .pdf links
    const detailLink = row.links.find((l) => /tenderdetail|detail|action|view/i.test(l.href || '') || /view|detail|action/i.test(l.text || ''))
      || row.links.find((l) => l.href && !/force_download|\.pdf/i.test(l.href) && /kppra/i.test(l.href));
    // KPPRA rows have multiple PDF links: Tender Doc and Bidding Doc
    const pdfLinks = row.links.filter((l) => /force_download|\.pdf/i.test(l.href || ''));
    const tenderDocLink = pdfLinks.find((l) => /tender/i.test(l.text || '')) || pdfLinks[0];
    const biddingDocLink = pdfLinks.find((l) => /bidding|bid/i.test(l.text || '')) || pdfLinks[1];
    // KPPRA detail pages use a JS popup (Action button) — can't deep-link.
    // Build a search URL that opens the portal filtered to this tender
    const portalSearchUrl = `http://www.kppra.gov.pk/kppra/activetenders.php?tender_ref=${encodeURIComponent(tenderNo)}`;
    const portalUrl = detailLink?.href || portalSearchUrl;
    // Deduplicate: if bidding doc is the same URL as tender doc, treat as single doc
    const tenderDocHref = tenderDocLink?.href || '';
    const biddingDocHref = (biddingDocLink?.href && biddingDocLink.href !== tenderDocHref) ? biddingDocLink.href : '';

    const kDescription = buildDescription({
      rawDetail: row.text || cells.join(' '),
      title: trimTitle(title),
      org: organization || 'KPK Government Entity',
      sector: inferSector([title, organization].join(' ')),
      type: inferTypeFromTitle(title)
    });

    candidates.push({
      id: `KPPRA-${tenderNo}-${closing}`,
      officialRef: tenderNo,
      title: trimTitle(title),
      description: kDescription,
      organization: organization || 'KPK Government Entity',
      ministry: '',
      province: snapshot.source.province,
      city: snapshot.source.city,
      type: inferTypeFromTitle(title),
      sector: inferSector([title, organization].join(' ')),
      referenceNumber: tenderNo,
      advertised,
      closing,
      closingTime: '',
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl: portalUrl,
      tenderNoticeUrl: tenderDocHref,
      biddingDocUrl: biddingDocHref,
      downloadUrl: tenderDocHref || biddingDocHref,
      evidenceText: row.text || cells.join(' | ')
    });
  }

  return candidates;
}

function parseAjkppra(snapshot) {
  // AJK PPRA table: [Procurement (type + ref), Title, Publishing Date, Closing Date, Department, Procuring Agency, Download]
  const AJK_HEADER_MAP = {
    procurement: ['procurement', 'type'],
    title: ['procurement title', 'title', 'description', 'name', 'subject'],
    advertised: ['publishing date', 'publishing', 'published', 'advertised'],
    closing: ['closing date', 'closing', 'deadline', 'last date'],
    department: ['department', 'dept'],
    agency: ['procuring agency', 'agency', 'organization']
  };

  const allRows = snapshot.tableRows.filter((row) => row.cells.length >= 5);
  const headerResult = detectHeaderRow(allRows, AJK_HEADER_MAP, 3);
  const candidates = [];

  for (const row of allRows) {
    const cells = row.cells;
    let procCell, titleCell, advertisedCell, closingCell, department, agency;

    if (headerResult) {
      const cm = headerResult.columnMap;
      procCell = clean(cells[cm.procurement ?? 0] || '');
      titleCell = clean(cells[cm.title ?? 1] || '');
      advertisedCell = cells[cm.advertised ?? 2] || '';
      closingCell = cells[cm.closing ?? 3] || '';
      department = clean(cells[cm.department ?? 4] || '');
      agency = clean(cells[cm.agency ?? 5] || '');
    } else {
      procCell = clean(cells[0] || '');
      titleCell = clean(cells[1] || '');
      advertisedCell = cells[2] || '';
      closingCell = cells[3] || '';
      department = clean(cells[4] || '');
      agency = clean(cells[5] || '');
    }

    // Extract ref number from procurement cell (e.g. "Tender Notice 6340")
    const refMatch = procCell.match(/(\d{3,})/);
    if (!refMatch) continue;
    const refNo = refMatch[1];

    // Parse the title — strip extra whitespace and boilerplate
    const title = trimTitle(dedupeRepeatedPhrase(titleCell));
    if (!title) continue;

    // Parse dates — AJK uses DD-MM-YYYY format
    const closing = normalizeDate(closingCell);
    const advertised = normalizeDate(advertisedCell);
    if (!closing) continue;

    // Determine tender type from the procurement cell
    const type = /prequalification/i.test(procCell) ? 'EOI'
      : /rfp|request for proposal/i.test(procCell) ? 'RFP'
      : /auction/i.test(procCell) ? 'Auction'
      : inferTypeFromTitle(title);

    const organization = agency || department || 'AJK Government Entity';

    // Get download link
    const downloadLink = row.links.find((l) => /download|\.pdf|uploadfiles/i.test(l.href || ''));
    const downloadUrl = downloadLink?.href || '';
    // Build a source URL — link to the portal page
    const sourceUrl = snapshot.sourceUrl || snapshot.source.sourceUrl;

    const ajkDesc = buildDescription({
      rawDetail: row.text || cells.join(' '),
      title,
      org: organization,
      sector: inferSector([title, organization, department].join(' ')),
      type
    });

    candidates.push({
      id: `AJKPPRA-${refNo}-${closing}`,
      officialRef: refNo,
      title,
      description: ajkDesc,
      organization,
      ministry: department || '',
      province: snapshot.source.province,
      city: snapshot.source.city,
      type,
      sector: inferSector([title, organization, department].join(' ')),
      referenceNumber: refNo,
      advertised,
      closing,
      closingTime: '',
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl,
      tenderNoticeUrl: downloadUrl,
      biddingDocUrl: '',
      downloadUrl,
      evidenceText: row.text || cells.join(' | ')
    });
  }

  return candidates;
}

function parsePunjab(snapshot) {
  const rows = snapshot.tableRows.filter((row) => row.cells.length >= 3 || row.links.length > 0);
  const candidates = [];

  for (const row of rows) {
    const flat = row.cells.map(clean).filter(Boolean);
    if (!flat.length) continue;

    const dates = flat.map(normalizeDate).filter(Boolean);
    const detailLink = row.links.find((item) => /ActiveTendersDetail/i.test(item.href || ''));
    const tenderNoticeLink = row.links.find((item) => /\/Tenders\/.*\.pdf/i.test(item.href || ''));
    const biddingDocLink = row.links.find((item) => /\/BiddingDocuments\/.*\.pdf/i.test(item.href || ''));
    const title = trimTitle(pickPunjabTitle(flat));
    const organization = pickPunjabOrganization(flat);
    const closing = pickLatestDate(dates);
    const advertised = pickEarliestDate(dates);

    if (!title || !closing) continue;
    if (!seemsTenderish(row.text)) continue;

    const referenceNumber = pickReference(flat);

    const pjDesc = buildDescription({
      rawDetail: row.text || flat.join(' '),
      title,
      org: organization || 'Punjab Government Entity',
      sector: inferSector([title, row.text].join(' ')),
      type: inferTypeFromTitle(title)
    });

    candidates.push({
      id: `PUNJAB-${slug(referenceNumber || title).slice(0, 48)}-${closing}`,
      officialRef: referenceNumber,
      title,
      description: pjDesc,
      organization: organization || 'Punjab Government Entity',
      ministry: '',
      province: snapshot.source.province,
      city: snapshot.source.city,
      type: inferTypeFromTitle(title),
      sector: inferSector([title, row.text].join(' ')),
      referenceNumber,
      advertised,
      closing,
      closingTime: extractTime(row.text),
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl: detailLink?.href || snapshot.sourceUrl || snapshot.source.sourceUrl,
      tenderNoticeUrl: tenderNoticeLink?.href || '',
      biddingDocUrl: biddingDocLink?.href || '',
      downloadUrl: tenderNoticeLink?.href || biddingDocLink?.href || '',
      evidenceText: row.text
    });
  }

  return dedupeByKey(candidates, (item) => `${item.title}::${item.closing}`);
}

function parsePpraDetailLine(line, ministryHint = '') {
  const text = clean(line);
  const match = text.match(/(.+?)\s+-\s+Pakistan\s+(Published|Corrigendum)\s+([A-Za-z]{3}\s+\d{2},\s+\d{4})\s+([A-Za-z]{3}\s+\d{2},\s+\d{4})\s+(\d{1,2}:\d{2}\s+[AP]M)$/i);
  if (!match) {
    return { organization: '', city: '', status: '', advertised: '', closing: '', closingTime: '' };
  }

  let orgAndCity = clean(match[1]);
  const ministry = clean(ministryHint);
  if (ministry && orgAndCity.toLowerCase().startsWith(ministry.toLowerCase())) {
    orgAndCity = clean(orgAndCity.slice(ministry.length));
  }

  let organization = orgAndCity;
  let city = '';
  const cityMatch = orgAndCity.match(/(.+?)\s+([A-Za-z.()\-]+)$/);
  if (cityMatch) {
    organization = clean(cityMatch[1]);
    city = clean(cityMatch[2]).replace(/\.+$/, '');
  }

  return {
    ministry,
    organization,
    city,
    status: clean(match[2]),
    advertised: normalizeDate(match[3]),
    closing: normalizeDate(match[4]),
    closingTime: clean(match[5])
  };
}

function parsePpraTitle(detailsCell) {
  const text = clean(detailsCell);
  // The details cell concatenates: <title> <description repeating title> <sector> <reference> <org>.
  // Find where a known sector keyword starts and take everything before it.
  let beforeSector = text;
  for (const sector of PPRA_SECTORS) {
    const idx = text.indexOf(sector);
    if (idx > 5) {
      beforeSector = clean(text.slice(0, idx));
      break;
    }
  }
  // The title is often repeated in the description — find the shortest repeated prefix
  const words = beforeSector.split(/\s+/);
  for (let len = Math.min(6, Math.floor(words.length / 2)); len <= Math.floor(words.length / 2); len++) {
    const candidate = words.slice(0, len).join(' ').toLowerCase();
    const rest = words.slice(len).join(' ').toLowerCase();
    if (candidate.length > 10 && rest.startsWith(candidate)) {
      return clean(words.slice(0, len).join(' '));
    }
  }
  // No obvious repeat — cap at a reasonable length
  if (beforeSector.length > 200) {
    const cutoff = beforeSector.lastIndexOf(' ', 200);
    return clean(beforeSector.slice(0, cutoff > 60 ? cutoff : 200));
  }
  return beforeSector;
}

function parsePpraReference(detailsCell, sector) {
  if (!sector) return '';
  const text = clean(detailsCell);
  const idx = text.indexOf(sector);
  if (idx === -1) return '';
  const afterSector = clean(text.slice(idx + sector.length));
  // Reference is usually the token(s) right after the sector, before the org name
  const refMatch = afterSector.match(/^([A-Za-z0-9/\-.,()]+(?:\s+[A-Za-z0-9/\-.,()]+){0,3})/);
  return refMatch ? clean(refMatch[1]) : '';
}

function parsePpraOrgCell(orgCell) {
  const text = clean(orgCell);
  // Format: "Ministry/Org Org City - Pakistan" or "Org City - Pakistan"
  const parts = text.replace(/\s*-\s*Pakistan\s*$/i, '').trim();
  // City is typically the last word
  const tokens = parts.split(/\s+/);
  const city = tokens.length > 1 ? tokens[tokens.length - 1].replace(/[.]+$/, '') : '';
  const orgAndMinistry = tokens.length > 1 ? tokens.slice(0, -1).join(' ') : parts;
  // First half is often ministry, but hard to split reliably — use it all as organization
  return {
    ministry: '',
    organization: clean(orgAndMinistry) || clean(parts),
    city: city
  };
}

function parsePpraClosing(closingCell) {
  const text = clean(closingCell);
  // Format: "Apr 13, 2026 09:30 AM"
  const timeMatch = text.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*$/i);
  const time = timeMatch ? clean(timeMatch[1]) : '';
  const dateStr = time ? clean(text.replace(timeMatch[0], '')) : text;
  return {
    date: normalizeDate(dateStr),
    time
  };
}

function parsePpraSector(line) {
  const cleaned = clean(line);
  return PPRA_SECTORS.find((sector) => cleaned.includes(sector)) || '';
}

function removeKnownPrefix(value, prefix) {
  if (!prefix) return clean(value);
  return clean(value).replace(new RegExp(`^${escapeRegex(prefix)}\\s*`, 'i'), '');
}

function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function normalizeDate(value) {
  const raw = clean(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const monthMap = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };

  const textMonth = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (textMonth) {
    const month = monthMap[textMonth[1].slice(0, 3).toLowerCase()];
    const day = textMonth[2].padStart(2, '0');
    return month ? `${textMonth[3]}-${month}-${day}` : '';
  }

  const textMonthLong = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/);
  if (textMonthLong) {
    const month = monthMap[textMonthLong[1].slice(0, 3).toLowerCase()];
    const day = textMonthLong[2].padStart(2, '0');
    return month ? `${textMonthLong[3]}-${month}-${day}` : '';
  }

  // DD-Mon-YYYY format (e.g. 10-Mar-2026)
  const dmyText = raw.match(/^(\d{1,2})-([A-Za-z]{3,9})-(\d{4})$/);
  if (dmyText) {
    const month = monthMap[dmyText[2].slice(0, 3).toLowerCase()];
    const day = dmyText[1].padStart(2, '0');
    return month ? `${dmyText[3]}-${month}-${day}` : '';
  }

  const dmy = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    return `${dmy[3]}-${month}-${day}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return '';
}

function inferTypeFromTitle(value) {
  const text = normalize(value);
  if (text.includes('request for proposal') || text.includes('rfp')) return 'RFP';
  if (text.includes('expression of interest') || text.includes('eoi') || text.includes('reoi')) return 'EOI';
  if (text.includes('auction')) return 'Auction';
  return 'Tender Notice';
}

function inferSector(value) {
  const text = normalize(value);
  if (/\b(?:cctv|camera|surveillance)\b/.test(text)) return 'Surveillance';
  if (/\b(?:server|network|vpn|hardware|laptop|computer|it equipment|printer|scanner|ups|router|switch)\b/.test(text)) return 'IT Hardware';
  if (/\b(?:software|web|portal|erp|mis|gis|database|ict|digitization|e-governance|cloud|hosting)\b/.test(text)) return 'Digital Platforms';
  if (/\b(?:it audit|it consultancy|cybersecurity|information security)\b/.test(text)) return 'Consultancy';
  return '';
}

function pickPunjabTitle(cells) {
  const candidates = cells
    .filter((cell) => cell.length >= 12)
    .filter((cell) => !normalizeDate(cell))
    .filter((cell) => !/^\d+$/.test(cell))
    .sort((a, b) => b.length - a.length);
  return dedupeRepeatedPhrase(candidates[0] || '');
}

function pickPunjabOrganization(cells) {
  return clean(cells.find((cell) => /department|authority|government|university|board|company|corporation|agency|directorate/i.test(cell)));
}

function pickReference(cells) {
  return clean(cells.find((cell) => /(tender|ref|ifb|it\/|proc\/|no\.?)/i.test(cell)));
}

function pickLatestDate(dates) {
  return dates.slice().sort().at(-1) || '';
}

function pickEarliestDate(dates) {
  return dates.slice().sort()[0] || '';
}

function extractTime(text) {
  const match = clean(text).match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
  return clean(match?.[1]);
}

function seemsTenderish(text) {
  const value = normalize(text);
  return /tender|bid|proposal|rfp|eoi|procurement|supply|installation|consultancy|services|equipment|software/.test(value);
}

function dedupeRepeatedPhrase(value) {
  const text = clean(value);
  const midpoint = Math.floor(text.length / 2);
  if (midpoint > 12) {
    const first = text.slice(0, midpoint).trim();
    const second = text.slice(midpoint).trim();
    if (first && second && normalize(first) === normalize(second)) return first;
  }
  return text;
}

function dedupeByKey(items, getKey) {
  const seen = new Map();
  for (const item of items) {
    const key = getKey(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return Array.from(seen.values());
}

function trimTitle(raw) {
  let text = clean(raw);
  if (!text) return text;
  // Strip boilerplate description text but keep the core title words intact
  text = text.replace(/\s*\d+\.\s*The procuring agency invites.*$/i, '');
  text = text.replace(/\s*A complete set of bidding.*$/i, '');
  text = text.replace(/\s*Bids prepared in accordance.*$/i, '');
  text = text.replace(/\s*Bidding documents may also.*$/i, '');
  text = text.replace(/\s*The advertisement along.*$/i, '');
  text = text.replace(/\s*Sealed bids are invited.*$/i, '');
  text = text.replace(/\s*Interested (bidders|firms|parties).*$/i, '');
  text = text.replace(/\s*For further (details|information).*$/i, '');
  text = text.replace(/\s*\(Download file for details\)\s*/gi, ' ');
  text = text.replace(/\s*\(View Tender Detail\)\s*/gi, ' ');
  text = text.replace(/\s*View Tender Detail\s*/gi, ' ');
  // Cap at 200 chars on a word boundary (generous — let the title carry real info)
  if (text.length > 200) {
    const cutoff = text.lastIndexOf(' ', 200);
    text = text.slice(0, cutoff > 60 ? cutoff : 200);
  }
  return clean(text);
}

export function smartTitle(raw) {
  let text = clean(raw);
  if (!text) return text;
  // Strip leading numbered lists (1., 2., etc.)
  text = text.replace(/^\d+\.\s*/, '');
  // Strip "Tender Notice" prefix if the rest is meaningful
  text = text.replace(/^Tender\s+Notice\s+/i, '').replace(/^Tender\s+for\s+/i, 'Procurement of ');
  // Strip boilerplate phrases
  text = text.replace(/\s*The procuring agency invites.*$/i, '');
  text = text.replace(/\s*A complete set of bidding.*$/i, '');
  text = text.replace(/\s*Bids prepared in accordance.*$/i, '');
  text = text.replace(/\s*Bidding documents may also.*$/i, '');
  text = text.replace(/\s*The advertisement along.*$/i, '');
  text = text.replace(/\s*Sealed bids are invited.*$/i, '');
  text = text.replace(/\s*Interested (bidders|firms|parties).*$/i, '');
  text = text.replace(/\s*For further (details|information).*$/i, '');
  // Remove generic filler that doesn't tell you what the tender is for
  text = text.replace(/\s*\(Download file for details\)\s*/gi, ' ');
  text = text.replace(/\s*\(View Tender Detail\)\s*/gi, ' ');
  text = text.replace(/\s*View Tender Detail\s*/gi, ' ');
  text = text.replace(/^Procurement\s+of\s+Procurement\s+of\s+/i, 'Procurement of ');
  text = clean(text);
  // Cap length at 180 chars on a word boundary (was 120 — too aggressive, lost context)
  if (text.length > 180) {
    const cutoff = text.lastIndexOf(' ', 180);
    text = text.slice(0, cutoff > 60 ? cutoff : 180);
  }
  // Smart case: fix ALL-CAPS words (preserve known acronyms)
  const knownAcronyms = /^(IT|ERP|CRM|MIS|GIS|CMS|LMS|ICT|AI|UPS|AV|HR|QA|DC|HQ|KPK|AJK|CCTV|PPRA|KPPRA|BPPRA|EPADS|MOITT|RFID|PABX|SCADA|PITB|NTISB|DGIP|WAPDA|NADRA|OGDCL|SNGPL|SSGC|OGRA|SECP|PEMRA|PIA|NHA|FBR|SBP|HEC|NUST|LUMS|NESPAK|NTC|PTCL|PTA|BISP|EOBI|NLC|ASF|FIA|NAB|ERRA|NDMA|FATA|PSDP|CPEC)$/;
  // First handle short ALL-CAPS words that are common English (OF, FOR, AND, THE, etc.)
  const lowercaseWords = /^(OF|FOR|AND|THE|IN|TO|AT|BY|ON|OR|AN|A|AS|IS|IT|IF|SO|NO|UP|DO|BE|WE|HE|ALL|BUT|NOT|ARE|WAS|HAS|HAD|ITS|OUR|HIS|HER|OUT|NEW|OLD|USE|SET|LET|GOT|CAN|MAY|OWN|ANY|FEW|DUE|PER|VIA|FROM|WITH|THAT|THIS|THAN|ALSO|INTO|OVER|UPON|EACH|SUCH|ONLY|VERY|BOTH|SAME|SOME|WILL|BEEN|HAVE|WERE|THEY|THEM|THEN|WHEN|MORE|MOST|MUCH|MANY|WELL|JUST|LIKE|MADE|MAKE|TAKE|COME|GIVE|KEEP|EVEN|GOOD|LONG|PART|HIGH|LAST|NEXT|USED|WORK|BACK|NEED|MUST|YEAR|UNDER|AFTER|OTHER|ABOUT|THEIR|WHICH|WOULD|COULD|THESE|WHERE|BEING|STILL|EVERY|THOSE|WHILE|SINCE|ALONG)$/;
  text = text.replace(/\b[A-Z]{2,}\b/g, (word) => {
    if (knownAcronyms.test(word)) return word;
    if (lowercaseWords.test(word)) return word.toLowerCase();
    // 4+ letter ALL-CAPS words: title case them
    if (word.length >= 4) return word.charAt(0) + word.slice(1).toLowerCase();
    return word;
  });
  // Ensure first letter is capitalized
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return clean(text);
}

/**
 * Build a concise, informative description from raw portal data.
 * Extracts detail beyond the title — what's being procured, for whom, and scope.
 * Falls back to assembling context from org/sector/type when raw text is sparse.
 */
function buildDescription({ rawDetail, title, org, sector, type }) {
  const titleNorm = normalize(title);

  // Extract text beyond the title from the raw detail
  let extra = clean(rawDetail);
  // Remove the title portion (may be repeated) to get the remaining detail
  if (titleNorm && extra.toLowerCase().includes(titleNorm)) {
    const idx = extra.toLowerCase().indexOf(titleNorm);
    const afterTitle = clean(extra.slice(idx + title.length));
    const beforeTitle = clean(extra.slice(0, idx));
    extra = afterTitle.length > beforeTitle.length ? afterTitle : beforeTitle;
  }

  // Strip common boilerplate from the extra text
  extra = extra
    .replace(/\b(The procuring agency invites|A complete set of bidding|Bids prepared in accordance|Bidding documents may also|The advertisement along|Sealed bids are invited|Interested (bidders|firms|parties)|For further (details|information)|Download file for details)\b.*/gi, '')
    .replace(/\b(Published|Corrigendum|Listed)\b/gi, '')
    .replace(/Closing\s+(?:Time|Date)\s*:?\s*/gi, '')
    .replace(/Opening\s+(?:Time|Date)\s*:?\s*/gi, '')
    .replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/gi, '')
    .replace(/\b\d{1,2}:\d{2}\s*(AM|PM)\b/gi, '')
    .replace(/\b(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|June?|July?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\s+\d{1,2},?\s+\d{4}\b/gi, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{1,2}[-\/]\d{1,2}[-\/]\d{4}\b/g, '')
    .replace(/\bTSE?\d+[A-Z]?\b/gi, '')
    .replace(/\s*\|\s*/g, ' ');
  extra = clean(extra);

  // Remove tokens that are just the org name or sector (already shown elsewhere)
  if (org) extra = extra.replace(new RegExp(escapeRegex(org), 'gi'), '').trim();
  if (sector) extra = extra.replace(new RegExp(escapeRegex(sector), 'gi'), '').trim();
  extra = clean(extra);

  // If we got meaningful extra text, use it as description
  if (extra.length > 15) {
    // Cap and clean
    if (extra.length > 250) {
      const cutoff = extra.lastIndexOf(' ', 250);
      extra = extra.slice(0, cutoff > 80 ? cutoff : 250);
    }
    return extra;
  }

  // Fallback: assemble a contextual description from structured fields
  const parts = [];
  if (type && type !== 'Tender Notice') parts.push(type);
  if (sector) parts.push(`Sector: ${sector}`);
  if (org) parts.push(`by ${org}`);
  const assembled = parts.join(' — ');
  return assembled || '';
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ══════════════════════════════════════════════════════════════════════════════
// GLOBAL PORTAL PARSERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * World Bank Procurement API parser.
 * Data comes pre-parsed as JSON in snapshot.apiData (array of notice objects).
 */
function parseWorldBank(snapshot) {
  const notices = snapshot.apiData;
  if (!Array.isArray(notices) || !notices.length) return [];

  const candidates = [];
  for (const notice of notices) {
    const id = clean(notice.noticenum || notice.id || '');
    const title = trimTitle(clean(notice.project_name || ''));
    if (!title || !id) continue;

    const closing = normalizeDate(clean(notice.closedate || ''));
    const advertised = normalizeDate(clean(notice.noticedate || ''));
    const country = clean(notice.country || notice.sub_region || 'Global');
    const organization = clean(notice.borrower || '');
    const sector = clean(notice.major_sector || '');
    const type = inferWBNoticeType(clean(notice.noticetype || ''));
    const noticeUrl = clean(notice.url || notice.project_url || '');

    const wbDesc = buildDescription({
      rawDetail: [organization, sector, country].filter(Boolean).join(' — '),
      title,
      org: organization,
      sector,
      type
    });

    candidates.push({
      id: `WB-${id}`,
      officialRef: id,
      title,
      description: wbDesc,
      organization,
      ministry: '',
      province: '',
      city: country,
      country,
      type,
      sector,
      referenceNumber: id,
      advertised,
      closing,
      closingTime: '',
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl: noticeUrl || snapshot.source.sourceUrl,
      tenderNoticeUrl: noticeUrl,
      biddingDocUrl: '',
      downloadUrl: '',
      evidenceText: [id, title, organization, country, advertised, closing].filter(Boolean).join(' | ')
    });
  }

  return candidates;
}

function inferWBNoticeType(noticetype) {
  const t = noticetype.toLowerCase();
  if (t.includes('request for proposal') || t.includes('rfp')) return 'RFP';
  if (t.includes('expression of interest') || t.includes('eoi') || t.includes('reoi')) return 'EOI';
  if (t.includes('invitation') || t.includes('ifb') || t.includes('icb')) return 'Tender Notice';
  if (t.includes('request for quotation') || t.includes('rfq')) return 'RFQ';
  return noticetype || 'Tender Notice';
}

/**
 * Bangladesh CPTU (Central Procurement Technical Unit) parser.
 * Scrapes https://www.cptu.gov.bd/active-tenders — standard table layout.
 */
function parseBangladeshCptu(snapshot) {
  const CPTU_HEADER_MAP = {
    id: ['id', 'ref', 'no', 'sl', 's.no', '#', 'tender no', 'notice no'],
    title: ['title', 'description', 'name', 'subject', 'tender title', 'procurement title'],
    organization: ['organization', 'procuring entity', 'entity', 'department', 'agency'],
    advertised: ['publish date', 'published', 'advertised', 'start', 'opening date'],
    closing: ['submission deadline', 'closing date', 'closing', 'deadline', 'end date', 'last date']
  };

  const allRows = snapshot.tableRows.filter(r => r.cells.length >= 3);
  const headerResult = detectHeaderRow(allRows, CPTU_HEADER_MAP, 3);
  const candidates = [];

  for (const row of allRows) {
    const cells = row.cells;
    let refCell, titleCell, orgCell, advertisedCell, closingCell;

    if (headerResult) {
      const cm = headerResult.columnMap;
      refCell = clean(cells[cm.id ?? 0] || '');
      titleCell = clean(cells[cm.title ?? 1] || '');
      orgCell = clean(cells[cm.organization ?? 2] || '');
      advertisedCell = cells[cm.advertised ?? 3] || '';
      closingCell = cells[cm.closing ?? 4] || '';
    } else {
      [refCell, titleCell, orgCell, advertisedCell, closingCell] = cells;
      refCell = clean(refCell || '');
      titleCell = clean(titleCell || '');
      orgCell = clean(orgCell || '');
    }

    const title = trimTitle(dedupeRepeatedPhrase(titleCell));
    if (!title || title.length < 5) continue;
    // Skip obvious header rows
    if (/^(title|description|name|subject|procurement title)$/i.test(title)) continue;

    const closing = normalizeDate(closingCell);
    const advertised = normalizeDate(advertisedCell);
    const ref = refCell || slug(title).slice(0, 20);
    const idKey = `BD-CPTU-${slug(ref || title).slice(0, 30)}-${closing || advertised || 'undated'}`;

    const detailLink = row.links.find(l => l.href && /cptu\.gov\.bd/i.test(l.href) && !/logo|icon|image/i.test(l.href));
    const downloadLink = row.links.find(l => l.href && /\.pdf$/i.test(l.href));

    candidates.push({
      id: idKey,
      officialRef: refCell,
      title,
      description: buildDescription({ rawDetail: row.text || cells.join(' '), title, org: orgCell, sector: inferSector([title, orgCell].join(' ')), type: inferTypeFromTitle(title) }),
      organization: orgCell || 'Bangladesh Government Entity',
      ministry: '',
      province: '',
      city: 'Dhaka',
      country: 'Bangladesh',
      type: inferTypeFromTitle(title),
      sector: inferSector([title, orgCell].join(' ')),
      referenceNumber: refCell,
      advertised,
      closing,
      closingTime: '',
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl: detailLink?.href || snapshot.sourceUrl || snapshot.source.sourceUrl,
      tenderNoticeUrl: downloadLink?.href || '',
      biddingDocUrl: '',
      downloadUrl: downloadLink?.href || '',
      evidenceText: row.text || cells.join(' | ')
    });
  }

  // Fallback: try anchors if table parsing yielded nothing
  if (!candidates.length) {
    for (const anchor of (snapshot.anchors || [])) {
      if (!anchor.text || anchor.text.length < 10) continue;
      if (!/cptu\.gov\.bd/i.test(anchor.href || '')) continue;
      if (/logo|icon|menu|nav|home|contact/i.test(anchor.text)) continue;
      const title = trimTitle(anchor.text);
      if (!title || title.length < 10) continue;
      candidates.push({
        id: `BD-CPTU-${slug(title).slice(0, 40)}`,
        officialRef: '',
        title,
        description: '',
        organization: 'Bangladesh Government Entity',
        ministry: '',
        province: '',
        city: 'Dhaka',
        country: 'Bangladesh',
        type: inferTypeFromTitle(title),
        sector: inferSector(title),
        referenceNumber: '',
        advertised: '',
        closing: '',
        closingTime: '',
        status: 'Listed',
        source: snapshot.source.label,
        sourceUrl: anchor.href || snapshot.source.sourceUrl,
        tenderNoticeUrl: anchor.href || '',
        biddingDocUrl: '',
        downloadUrl: '',
        evidenceText: anchor.text
      });
    }
  }

  return dedupeByKey(candidates, t => `${normalize(t.title)}::${t.closing}`);
}

/**
 * Kenya PPRA (Public Procurement Regulatory Authority) parser.
 * Scrapes https://ppra.go.ke/tenders/
 */
function parseKenyaPpra(snapshot) {
  const KPPRA_KE_HEADER_MAP = {
    ref: ['ref', 'ref no', 'tender no', 'no', '#', 'id'],
    title: ['title', 'description', 'tender', 'subject', 'name', 'procurement title'],
    organization: ['entity', 'procuring entity', 'organization', 'department', 'agency', 'ministry'],
    category: ['category', 'type', 'sector'],
    closing: ['closing date', 'deadline', 'closing', 'submission', 'end date', 'last date']
  };

  const allRows = snapshot.tableRows.filter(r => r.cells.length >= 3);
  const headerResult = detectHeaderRow(allRows, KPPRA_KE_HEADER_MAP, 3);
  const candidates = [];

  for (const row of allRows) {
    const cells = row.cells;
    let refCell, titleCell, orgCell, categoryCell, closingCell;

    if (headerResult) {
      const cm = headerResult.columnMap;
      refCell = clean(cells[cm.ref ?? 0] || '');
      titleCell = clean(cells[cm.title ?? 1] || '');
      orgCell = clean(cells[cm.organization ?? 2] || '');
      categoryCell = clean(cells[cm.category ?? 3] || '');
      closingCell = cells[cm.closing ?? 4] || '';
    } else {
      [refCell, titleCell, orgCell, categoryCell, closingCell] = cells;
      refCell = clean(refCell || '');
      titleCell = clean(titleCell || '');
      orgCell = clean(orgCell || '');
      categoryCell = clean(categoryCell || '');
    }

    const title = trimTitle(dedupeRepeatedPhrase(titleCell));
    if (!title || title.length < 5) continue;
    if (/^(title|description|tender|name|subject)$/i.test(title)) continue;

    const closing = normalizeDate(closingCell);
    const ref = refCell || slug(title).slice(0, 20);
    const idKey = `KE-PPRA-${slug(ref || title).slice(0, 30)}-${closing || 'undated'}`;

    const detailLink = row.links.find(l => l.href && !/logo|icon|image/i.test(l.href));
    const pdfLink = row.links.find(l => l.href && /\.pdf$/i.test(l.href));

    candidates.push({
      id: idKey,
      officialRef: refCell,
      title,
      description: buildDescription({ rawDetail: row.text || cells.join(' '), title, org: orgCell, sector: inferSector([title, orgCell, categoryCell].join(' ')), type: inferTypeFromTitle(title) }),
      organization: orgCell || 'Kenya Government Entity',
      ministry: '',
      province: '',
      city: 'Nairobi',
      country: 'Kenya',
      type: categoryCell || inferTypeFromTitle(title),
      sector: inferSector([title, orgCell, categoryCell].join(' ')),
      referenceNumber: refCell,
      advertised: '',
      closing,
      closingTime: '',
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl: detailLink?.href || snapshot.sourceUrl || snapshot.source.sourceUrl,
      tenderNoticeUrl: pdfLink?.href || detailLink?.href || '',
      biddingDocUrl: '',
      downloadUrl: pdfLink?.href || '',
      evidenceText: row.text || cells.join(' | ')
    });
  }

  // Fallback: parse from anchors
  if (!candidates.length) {
    for (const anchor of (snapshot.anchors || [])) {
      if (!anchor.text || anchor.text.length < 10) continue;
      if (/ppra\.go\.ke/i.test(anchor.href || '') && !/logo|icon|home|contact|menu|login/i.test(anchor.text)) {
        const title = trimTitle(anchor.text);
        if (!title || title.length < 10) continue;
        candidates.push({
          id: `KE-PPRA-${slug(title).slice(0, 40)}`,
          officialRef: '',
          title,
          description: '',
          organization: 'Kenya Government Entity',
          ministry: '',
          province: '',
          city: 'Nairobi',
          country: 'Kenya',
          type: inferTypeFromTitle(title),
          sector: inferSector(title),
          referenceNumber: '',
          advertised: '',
          closing: '',
          closingTime: '',
          status: 'Listed',
          source: snapshot.source.label,
          sourceUrl: anchor.href || snapshot.source.sourceUrl,
          tenderNoticeUrl: anchor.href || '',
          biddingDocUrl: '',
          downloadUrl: '',
          evidenceText: anchor.text
        });
      }
    }
  }

  return dedupeByKey(candidates, t => `${normalize(t.title)}::${t.closing}`);
}

/**
 * African Development Bank (AfDB) procurement parser.
 * Scrapes https://www.afdb.org/en/projects-and-operations/procurement
 */
function parseAfdb(snapshot) {
  const AFDB_HEADER_MAP = {
    ref: ['ref', 'no', 'id', 'reference', 'project id', '#'],
    title: ['title', 'description', 'notice', 'name', 'subject', 'procurement'],
    country: ['country', 'region', 'location'],
    organization: ['executing agency', 'agency', 'organization', 'borrower', 'entity'],
    type: ['type', 'category', 'notice type'],
    closing: ['deadline', 'closing', 'submission deadline', 'closing date', 'end date']
  };

  const allRows = snapshot.tableRows.filter(r => r.cells.length >= 3);
  const headerResult = detectHeaderRow(allRows, AFDB_HEADER_MAP, 3);
  const candidates = [];

  for (const row of allRows) {
    const cells = row.cells;
    let refCell, titleCell, countryCell, orgCell, typeCell, closingCell;

    if (headerResult) {
      const cm = headerResult.columnMap;
      refCell = clean(cells[cm.ref ?? 0] || '');
      titleCell = clean(cells[cm.title ?? 1] || '');
      countryCell = clean(cells[cm.country ?? 2] || '');
      orgCell = clean(cells[cm.organization ?? 3] || '');
      typeCell = clean(cells[cm.type ?? 4] || '');
      closingCell = cells[cm.closing ?? 5] || '';
    } else {
      [refCell, titleCell, countryCell, orgCell, typeCell, closingCell] = cells;
      refCell = clean(refCell || '');
      titleCell = clean(titleCell || '');
      countryCell = clean(countryCell || '');
      orgCell = clean(orgCell || '');
      typeCell = clean(typeCell || '');
    }

    const title = trimTitle(dedupeRepeatedPhrase(titleCell));
    if (!title || title.length < 5) continue;
    if (/^(title|description|notice|name|subject)$/i.test(title)) continue;

    const closing = normalizeDate(closingCell);
    const country = countryCell || 'Africa';
    const ref = refCell || slug(title).slice(0, 20);
    const idKey = `AFDB-${slug(ref || title).slice(0, 30)}-${closing || 'undated'}`;

    const detailLink = row.links.find(l => l.href && /afdb\.org/i.test(l.href) && !/logo|icon|image/i.test(l.href));
    const pdfLink = row.links.find(l => l.href && /\.pdf$/i.test(l.href));

    candidates.push({
      id: idKey,
      officialRef: refCell,
      title,
      description: buildDescription({ rawDetail: row.text || cells.join(' '), title, org: orgCell, sector: inferSector([title, orgCell].join(' ')), type: typeCell || inferTypeFromTitle(title) }),
      organization: orgCell || 'AfDB Member Country',
      ministry: '',
      province: '',
      city: country,
      country,
      type: typeCell || inferTypeFromTitle(title),
      sector: inferSector([title, orgCell].join(' ')),
      referenceNumber: refCell,
      advertised: '',
      closing,
      closingTime: '',
      status: 'Listed',
      source: snapshot.source.label,
      sourceUrl: detailLink?.href || snapshot.sourceUrl || snapshot.source.sourceUrl,
      tenderNoticeUrl: pdfLink?.href || detailLink?.href || '',
      biddingDocUrl: '',
      downloadUrl: pdfLink?.href || '',
      evidenceText: row.text || cells.join(' | ')
    });
  }

  // Fallback: parse from anchors
  if (!candidates.length) {
    for (const anchor of (snapshot.anchors || [])) {
      if (!anchor.text || anchor.text.length < 10) continue;
      if (/afdb\.org/i.test(anchor.href || '') && /procurement|tender|bid|project/i.test(anchor.href || '')) {
        const title = trimTitle(anchor.text);
        if (!title || title.length < 10) continue;
        candidates.push({
          id: `AFDB-${slug(title).slice(0, 40)}`,
          officialRef: '',
          title,
          description: '',
          organization: 'AfDB Member Country',
          ministry: '',
          province: '',
          city: 'Africa',
          country: 'Africa',
          type: inferTypeFromTitle(title),
          sector: inferSector(title),
          referenceNumber: '',
          advertised: '',
          closing: '',
          closingTime: '',
          status: 'Listed',
          source: snapshot.source.label,
          sourceUrl: anchor.href || snapshot.source.sourceUrl,
          tenderNoticeUrl: anchor.href || '',
          biddingDocUrl: '',
          downloadUrl: '',
          evidenceText: anchor.text
        });
      }
    }
  }

  return dedupeByKey(candidates, t => `${normalize(t.title)}::${t.closing}`);
}
