import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

loadEnv(path.join(rootDir, '.env'));

// ── Pakistan Portals ──────────────────────────────────────────────────────────
const PAKISTAN_PORTALS = [
  {
    id: 'punjab-eproc',
    label: 'Punjab e-Procurement',
    country: 'Pakistan',
    flag: '🇵🇰',
    province: 'Punjab',
    city: 'Lahore',
    sourceUrl: 'https://eproc.punjab.gov.pk/ActiveTenders.aspx'
  },
  {
    id: 'ppra-federal',
    label: 'PPRA (EPMS)',
    country: 'Pakistan',
    flag: '🇵🇰',
    province: 'Federal',
    city: 'Islamabad',
    sourceUrl: 'https://epms.ppra.gov.pk/public/tenders/active-tenders'
  },
  {
    id: 'epads-federal',
    label: 'PPRA (EPADS v2)',
    country: 'Pakistan',
    flag: '🇵🇰',
    province: 'Federal',
    city: 'Islamabad',
    sourceUrl: 'https://epads.gov.pk/#active-procurement'
  },
  {
    id: 'moitt',
    label: 'MoITT',
    country: 'Pakistan',
    flag: '🇵🇰',
    province: 'Federal',
    city: 'Islamabad',
    sourceUrl: 'https://moitt.gov.pk/Tenders'
  },
  {
    id: 'kppra-kpk',
    label: 'KPPRA KPK',
    country: 'Pakistan',
    flag: '🇵🇰',
    province: 'Khyber Pakhtunkhwa',
    city: 'Peshawar',
    sourceUrl: 'http://www.kppra.gov.pk/kppra/activetenders'
  },
  {
    id: 'ajkppra',
    label: 'AJK PPRA',
    country: 'Pakistan',
    flag: '🇵🇰',
    province: 'AJK',
    city: 'Muzaffarabad',
    sourceUrl: 'https://www.ajkppra.gov.pk/advertisements.php'
  }
];

// ── Global Portals ────────────────────────────────────────────────────────────
const GLOBAL_PORTALS = [
  {
    id: 'world-bank',
    label: 'World Bank Procurement',
    country: 'Global',
    flag: '🌍',
    province: '',
    city: '',
    sourceUrl: 'https://search.worldbank.org/api/v2/procurement',
    type: 'api'
  },
  {
    id: 'bangladesh-cptu',
    label: 'Bangladesh CPTU',
    country: 'Bangladesh',
    flag: '🇧🇩',
    province: '',
    city: 'Dhaka',
    sourceUrl: 'https://www.cptu.gov.bd/active-tenders'
  },
  {
    id: 'kenya-ppra',
    label: 'Kenya PPRA',
    country: 'Kenya',
    flag: '🇰🇪',
    province: '',
    city: 'Nairobi',
    sourceUrl: 'https://ppra.go.ke/tenders/'
  },
  {
    id: 'afdb',
    label: 'African Development Bank',
    country: 'Africa (Multi)',
    flag: '🌍',
    province: '',
    city: 'Abidjan',
    sourceUrl: 'https://www.afdb.org/en/projects-and-operations/procurement'
  }
];

const ALL_PORTALS = [...PAKISTAN_PORTALS, ...GLOBAL_PORTALS];

// ── Relevance Keywords ────────────────────────────────────────────────────────
// Used for heuristic scoring — tenders matching these keywords get higher scores.
// Covers IT, digital, fintech, healthcare IT, and related sectors.
const RELEVANCE_KEYWORDS = [
  // Software & platforms
  'software', 'web', 'website', 'application', 'platform', 'portal',
  'digital', 'digitization', 'digitisation', 'ict',
  'government operating system', 'govos', 'public services delivery',
  'unified digital government', 'super app', 'e-governance', 'e-government',
  'erp', 'mis', 'gis', 'cms', 'crm',

  // Development & consulting
  'consultancy', 'it consultancy', 'system integration', 'integration',
  'software development', 'web development', 'app development',
  'system development', 'solution development',

  // Finance & fintech
  'fintech', 'banking', 'payment', 'wallet', 'aml', 'kyc',
  'mobile banking', 'digital banking', 'core banking', 'payment gateway',
  'pos', 'point of sale', 'atm', 'card management', 'switch',
  'remittance', 'money transfer', 'lending platform', 'loan management',
  'insurance', 'insurtech', 'microfinance', 'branchless banking',
  'treasury', 'financial management', 'accounting software', 'billing system',
  'revenue management', 'tax management', 'e-payment', 'epayment',
  'digital payment', 'mobile money', 'mobile wallet',
  'central bank', 'regulatory', 'compliance',
  'credit scoring', 'risk management', 'fraud detection', 'fraud prevention',
  'open banking', 'api banking', 'neobank', 'digital lending',
  'payroll', 'invoicing', 'financial inclusion', 'agent banking',
  'qr code', 'contactless', 'nfc', 'chip', 'emv',
  'clearing house', 'settlement', 'rtgs', 'ach',
  'budget management', 'expenditure', 'financial reporting',

  // Security
  'cyber', 'cybersecurity', 'information security', 'firewall',

  // Audit & validation
  'audit', 'it audit', 'validation',

  // Networking & infrastructure
  'network', 'networking', 'vpn', 'router', 'switch', 'fiber', 'fibre',
  'broadband', 'wifi', 'wi-fi', 'lan', 'wan',
  'server', 'data center', 'data centre', 'cloud', 'hosting',
  'data storage', 'backup', 'ups', 'database',
  'telecom', 'telecommunication',

  // Hardware & equipment
  'hardware', 'it equipment', 'laptop', 'computer', 'desktop',
  'printer', 'scanner', 'projector', 'led display',
  'biometric', 'access control', 'rfid',

  // Surveillance & smart city
  'camera', 'cctv', 'surveillance', 'smart city',
  'parking', 'traffic management',

  // Monitoring & analytics
  'monitoring', 'dashboard', 'analytics', 'reporting',

  // Emerging tech
  'automation', 'ai', 'artificial intelligence', 'machine learning',
  'blockchain', 'iot', 'internet of things',

  // Healthcare & health IT
  'health information', 'his', 'hospital management', 'hms', 'emr',
  'electronic medical record', 'ehr', 'electronic health record',
  'telemedicine', 'telehealth', 'health app', 'patient management',
  'lims', 'laboratory information', 'pharmacy management', 'radiology',
  'pacs', 'medical equipment', 'medical device', 'biomedical',
  'health monitoring', 'disease surveillance', 'dhis', 'health portal',
  'e-health', 'ehealth', 'mhealth', 'health software',
  'healthcare', 'health care', 'health services', 'health sector',
  'clinical', 'diagnostic', 'medical imaging', 'blood bank',
  'vaccine', 'immunization', 'nutrition', 'maternal health',
  'ambulance', 'emergency medical', 'medical supplies',
  'hospital equipment', 'surgical', 'icu', 'ventilator', 'oxygen',
  'medical waste', 'sterilization', 'autoclave',
  'public health', 'epidemiology', 'health management',
  'health insurance', 'health card',

  // Education tech
  'maker space', 'steam lab', 'computer lab', 'it lab',
  'lms', 'learning management', 'e-learning', 'elearning',

  // Broader catch-all terms
  'electronic', 'e-procurement', 'e-tendering', 'e-billing',
  'information technology', 'information system', 'management system',
  'online', 'digitalize', 'digitalisation', 'computerization', 'computerize',
  'workstation', 'tablet', 'ups system', 'inverter',
  'optical fiber', 'ofc', 'ftth', 'connectivity', 'bandwidth',
  'data entry', 'data processing', 'data management',
  'video conferencing', 'conferencing system', 'video wall', 'display board',
  'audio visual', 'av system', 'intercom', 'public address', 'pa system',
  'solar', 'ip camera', 'nvr', 'dvr',
  'asset tracking', 'gps', 'tracking system',
  'queue management', 'kiosk', 'touch screen',
  'mis report', 'sap', 'oracle', 'microsoft',
  'call center', 'helpdesk', 'help desk',
  'procurement of equipment', 'supply of equipment', 'installation of equipment',
  'photocopier', 'copier', 'fax', 'multimedia', 'smart board', 'interactive board',
  'attendance', 'face recognition', 'fingerprint', 'access point', 'wireless',
  'cabling', 'structured cabling', 'cat6', 'rack', 'patch panel',
  'generator', 'power supply', 'stabilizer', 'voltage',
  'pabx', 'telephone', 'exchange', 'pbx', 'ip phone',
  'security system', 'alarm', 'metal detector', 'baggage scanner',
  'e-office', 'e-filing', 'digitize', 'scanning', 'document management',

  // Software types
  'saas', 'api', 'mobile app', 'mobile application', 'android', 'ios',
  'web application', 'web portal', 'custom software', 'bespoke software',
  'enterprise software', 'cloud computing', 'virtualization', 'vmware',
  'devops', 'ci cd', 'microservices', 'containerization',
  'data warehouse', 'big data', 'business intelligence', 'bi tool',

  // Hardware & infra
  'server rack', 'blade server', 'nas', 'san', 'storage area network',
  'firewall appliance', 'load balancer', 'network attached',
  'thin client', 'all in one', 'workstation', 'mini pc',
  'it infrastructure', 'infrastructure upgrade', 'network upgrade',
  'data center upgrade', 'it procurement', 'it services',
  'managed services', 'outsourcing', 'bpo', 'it support',
  'annual maintenance', 'amc', 'maintenance contract'
];

export const config = {
  rootDir,
  dataDir: path.join(rootDir, 'data'),
  cacheFile: path.join(rootDir, 'data', 'tenders.json'),
  assignmentsFile: path.join(rootDir, 'data', 'assignments.json'),
  notesFile: path.join(rootDir, 'data', 'notes.json'),
  activityFile: path.join(rootDir, 'data', 'activity.json'),
  archiveFile: path.join(rootDir, 'data', 'archive.json'),
  usersFile: path.join(rootDir, 'data', 'users.json'),
  bookmarksFile: path.join(rootDir, 'data', 'bookmarks.json'),
  scheduleFile: path.join(rootDir, 'data', 'schedule.json'),
  settingsFile: path.join(rootDir, 'data', 'settings.json'),
  port: Number(process.env.PORT || 3001),
  playwrightHeadless: String(process.env.PLAYWRIGHT_HEADLESS || 'true') !== 'false',
  refreshCron: process.env.REFRESH_CRON || '0 8 * * *',
  maxPageTextChars: Number(process.env.MAX_PAGE_TEXT_CHARS || 50000),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 120000),
  timezone: 'UTC',
  authSecret: process.env.AUTH_SECRET || '',
  authUsers: process.env.AUTH_USERS || '',
  officialPortals: ALL_PORTALS,
  relevanceKeywords: RELEVANCE_KEYWORDS,
  authUsernames: (process.env.AUTH_USERS || '')
    .split(',')
    .map(entry => entry.trim().split(':')[0])
    .filter(Boolean),
  masterUsers: (process.env.AUTH_MASTER_USERS || '')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean)
};

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

// Validate critical config at module load
(function validateConfig() {
  if (!config.authSecret) console.warn('[config] WARNING: AUTH_SECRET is empty — sessions will be insecure');
  if (!config.authUsers && !fs.existsSync(config.usersFile)) console.warn('[config] WARNING: No AUTH_USERS and no users.json — nobody can log in');
  if (config.port < 1 || config.port > 65535) throw new Error(`[config] Invalid PORT: ${config.port}`);
  if (config.requestTimeoutMs < 5000) console.warn(`[config] REQUEST_TIMEOUT_MS (${config.requestTimeoutMs}ms) is very low`);
})();
