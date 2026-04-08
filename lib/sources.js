import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { config } from './config.js';

chromium.use(StealthPlugin());

export async function collectSnapshots(onProgress) {
  const portals = config.officialPortals;
  const browserPortals = portals.filter(p => p.type !== 'api');
  const apiPortals = portals.filter(p => p.type === 'api');

  // Launch browser only if there are browser-based portals
  let browser = null;
  if (browserPortals.length) {
    browser = await chromium.launch({
      headless: config.playwrightHeadless,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-translate',
        '--no-zygote'
      ]
    });
  }

  try {
    const snapshots = [];
    for (let idx = 0; idx < portals.length; idx++) {
      const source = portals[idx];
      if (onProgress) onProgress(source, idx, 'start');

      let snap;
      if (source.type === 'api') {
        snap = await fetchApiSnapshot(source);
      } else {
        snap = await fetchSourceSnapshot(browser, source);
        if (!snap.ok) {
          console.log(`[scrape] Retry 1 for ${source.label}: ${snap.error}`);
          if (onProgress) onProgress(source, idx, 'retry');
          await new Promise(r => setTimeout(r, 3000));
          snap = await fetchSourceSnapshot(browser, source);
        }
        if (!snap.ok) {
          console.log(`[scrape] Retry 2 for ${source.label}: ${snap.error}`);
          if (onProgress) onProgress(source, idx, 'retry');
          await new Promise(r => setTimeout(r, 6000));
          snap = await fetchSourceSnapshot(browser, source);
        }
      }

      snapshots.push(snap);
      if (onProgress) onProgress(source, idx, 'done');
    }
    return snapshots;
  } finally {
    if (browser) await browser.close();
  }
}

// ── API-based portal fetching ─────────────────────────────────────────────────

async function fetchApiSnapshot(source) {
  const startedAt = new Date().toISOString();
  try {
    if (source.id === 'world-bank') {
      return await fetchWorldBankSnapshot(source, startedAt);
    }
    return { ok: false, source, sourceTitle: '', sourceUrl: source.sourceUrl, fetchedAt: startedAt, rawText: '', text: '', tableRows: [], anchors: [], apiData: null, error: `No API handler for ${source.id}` };
  } catch (err) {
    return { ok: false, source, sourceTitle: '', sourceUrl: source.sourceUrl, fetchedAt: startedAt, rawText: '', text: '', tableRows: [], anchors: [], apiData: null, error: err.message };
  }
}

async function fetchWorldBankSnapshot(source, startedAt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  // World Bank Procurement Notices API
  const url = new URL('https://search.worldbank.org/api/v2/procurement');
  url.searchParams.set('format', 'json');
  url.searchParams.set('rows', '100');
  url.searchParams.set('qterm', '');
  url.searchParams.set('finfo', 'id,noticenum,noticedate,closedate,noticetype,project_name,project_url,url,country,countrycode,sub_region,major_sector,borrower,contact_info');

  const res = await fetch(url.toString(), {
    signal: controller.signal,
    headers: { 'Accept': 'application/json', 'User-Agent': 'OpenTenders/2.0 (open source procurement monitor)' }
  });
  clearTimeout(timer);

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();

  // The API response has a `procurement` array
  const notices = json.procurement || [];
  const rawText = notices.map(n => [n.project_name, n.borrower, n.country, n.noticetype].filter(Boolean).join(' ')).join(' ');

  return {
    ok: true,
    source,
    sourceTitle: 'World Bank Procurement Notices',
    sourceUrl: source.sourceUrl,
    fetchedAt: startedAt,
    rawText,
    text: rawText.slice(0, 50000),
    tableRows: [],
    anchors: [],
    apiData: notices,
    error: null
  };
}

async function fetchSourceSnapshot(browser, source) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1200 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  const page = await context.newPage();
  const startedAt = new Date().toISOString();

  try {
    // Some portals are slow — give them extra time
    const verySlowPortals = ['punjab-eproc', 'moitt', 'kppra-kpk'];
    const isVerySlow = verySlowPortals.includes(source.id);
    const navTimeout = isVerySlow ? config.requestTimeoutMs * 2 : config.requestTimeoutMs;
    await page.goto(source.sourceUrl, { waitUntil: 'commit', timeout: navTimeout });
    // Wait for DOM to be ready before looking for content selectors
    try { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch { /* ok */ }
    // Adaptive wait: try to detect content readiness instead of fixed delays.
    // For each portal, wait for a content selector first, then fall back to a shorter fixed wait.
    const selectorHints = {
      'punjab-eproc': 'table tr, .gridview tr, #ContentPlaceHolder1_gvActiveTenders tr',
      'ppra-federal': 'table tbody tr, .tender-row, .dataTables_wrapper tr',
      'moitt': 'table tr, .tender, article',
      'epads-federal': 'table tr, .procurement-row, .table tr',
      'kppra-kpk': 'table tr, .tender-row',
      'ajkppra': 'table tr, .advertisement',
      'bangladesh-cptu': 'table tr, .tender-list tr, .procurement-list tr',
      'kenya-ppra': 'table tr, .tender-row, .tenders-table tr',
      'afdb': 'table tr, .procurement-row, .views-row'
    };
    const hint = selectorHints[source.id];
    const maxWaitMs = source.id === 'punjab-eproc' ? 15000
      : source.id === 'ppra-federal' ? 10000
      : source.id === 'moitt' ? 10000
      : source.id === 'epads-federal' ? 8000
      : 5000;

    if (hint) {
      try {
        await page.locator(hint).first().waitFor({ state: 'attached', timeout: maxWaitMs });
      } catch {
        // Selector not found — fall back to fixed wait (allows for slow Azure→Pakistan routing)
        await page.waitForTimeout(Math.min(maxWaitMs, 6000));
      }
    } else {
      await page.waitForTimeout(maxWaitMs);
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch {
      // not all portals become fully idle
    }

    await acceptCookieOrDismiss(page);
    await expandPageIfPossible(page, source.id);

    const title = await page.title();

    // Collect page 1 raw text and table rows BEFORE pagination navigates away
    // Wrapped in try/catch to handle "execution context destroyed" on redirecting sites
    const rawTextPage1 = await page.locator('body').innerText({ timeout: 20000 }).catch(() => '');
    const tableRowsPage1 = await collectTableRows(page).catch(() => []);

    // Collect additional pages for portals with pagination
    let extraTableRows = [];
    let extraRawText = '';
    const paginatedPortals = ['kppra-kpk', 'ppra-federal', 'epads-federal', 'punjab-eproc'];
    if (paginatedPortals.includes(source.id)) {
      extraTableRows = await collectExtraPages(page, source.id);
      if (extraTableRows.length) {
        extraRawText = extraTableRows.map(r => r.text || '').join(' ');
      }
    }

    const rawText = rawTextPage1 + ' ' + extraRawText;
    const tableRows = [...tableRowsPage1, ...extraTableRows];

    const anchors = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map((a) => ({
        text: (a.innerText || '').replace(/\s+/g, ' ').trim(),
        href: a.href
      })).filter((item) => item.href);
    });

    return {
      ok: true,
      source,
      sourceTitle: title,
      sourceUrl: page.url(),
      fetchedAt: startedAt,
      rawText,
      text: compactWhitespace(rawText).slice(0, config.maxPageTextChars),
      tableRows,
      anchors,
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      source,
      sourceTitle: '',
      sourceUrl: source.sourceUrl,
      fetchedAt: startedAt,
      rawText: '',
      text: '',
      tableRows: [],
      anchors: [],
      error: error.message
    };
  } finally {
    await context.close();
  }
}

async function acceptCookieOrDismiss(page) {
  const buttonTexts = ['Accept', 'I Agree', 'AGREE', 'OK', 'Got it', 'Allow all'];
  for (const text of buttonTexts) {
    const locator = page.getByRole('button', { name: new RegExp(`^${escapeRegex(text)}$`, 'i') });
    try {
      if (await locator.first().isVisible({ timeout: 500 })) {
        await locator.first().click({ timeout: 1000 });
        await page.waitForTimeout(500);
        return;
      }
    } catch {
      // ignore
    }
  }
}

async function expandPageIfPossible(page, sourceId) {
  const buttons =
    sourceId === 'punjab-eproc' ? ['Search', 'Submit', 'View', 'Go'] :
    null;

  if (!buttons) return;

  for (const label of buttons) {
    try {
      const button = page.getByRole('button', { name: new RegExp(label, 'i') }).first();
      if (await button.isVisible({ timeout: 700 })) {
        await button.click({ timeout: 1500 });
        return;
      }
    } catch {
      // ignore
    }
  }
}

/** Extract table rows from the current page state */
async function collectTableRows(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const rows = [];
    for (const table of tables) {
      const trs = Array.from(table.querySelectorAll('tr'));
      for (const tr of trs) {
        const directCells = Array.from(tr.querySelectorAll(':scope > th, :scope > td'));
        const cellSource = directCells.length > 0 ? directCells : Array.from(tr.querySelectorAll('th,td'));
        const cells = cellSource.map((cell) => (cell.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const cellHeadings = cellSource.map((cell) => {
          const heading = cell.querySelector('h1, h2, h3, h4, h5, h6, strong, b');
          return heading ? (heading.innerText || '').replace(/\s+/g, ' ').trim() : '';
        });
        const links = Array.from(tr.querySelectorAll('a[href]')).map((a) => ({
          text: (a.innerText || '').replace(/\s+/g, ' ').trim(),
          href: a.href
        })).filter((item) => item.href);
        const text = (tr.innerText || '').replace(/\s+/g, ' ').trim();
        if (cells.length || links.length) rows.push({ cells, cellHeadings, links, text });
      }
    }
    return rows;
  });
}

/** Collect table rows from additional pagination pages */
async function collectExtraPages(page, sourceId) {
  const allRows = [];
  const maxPages = 10;

  if (sourceId === 'kppra-kpk') {
    // KPPRA: pagination links like ?p=2, ?p=3
    for (let pageNum = 2; pageNum <= maxPages; pageNum++) {
      try {
        const nextLink = page.locator(`a[href*="p=${pageNum}"]`).first();
        if (await nextLink.isVisible({ timeout: 800 })) {
          await nextLink.click({ timeout: 2000 });
          await page.waitForTimeout(600);
          try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}
          allRows.push(...await collectTableRows(page));
        } else break;
      } catch { break; }
    }
  } else if (sourceId === 'ppra-federal' || sourceId === 'epads-federal') {
    // PPRA EPADS: ?page=2  |  EPADS Federal: ?page=2
    for (let pageNum = 2; pageNum <= maxPages; pageNum++) {
      try {
        const nextLink = page.locator(`a[href*="page=${pageNum}"]`).first();
        if (await nextLink.isVisible({ timeout: 800 })) {
          await nextLink.click({ timeout: 2000 });
          await page.waitForTimeout(800);
          try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch {}
          allRows.push(...await collectTableRows(page));
        } else break;
      } catch { break; }
    }
  } else if (sourceId === 'punjab-eproc') {
    // Punjab: ASP.NET postback pagination — click page number links
    for (let pageNum = 2; pageNum <= maxPages; pageNum++) {
      try {
        // Punjab pagination uses links with text "2", "3", etc.
        const pageLink = page.locator(`a`).filter({ hasText: new RegExp(`^${pageNum}$`) }).first();
        if (await pageLink.isVisible({ timeout: 800 })) {
          await pageLink.click({ timeout: 2000 });
          await page.waitForTimeout(1000);
          try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch {}
          allRows.push(...await collectTableRows(page));
        } else break;
      } catch { break; }
    }
  }

  return allRows;
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
