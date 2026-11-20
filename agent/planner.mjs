import path from 'node:path';
import { LOCAL_TEXT_EXTENSIONS } from '../tools/report_tools.mjs';

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

const STOP_WORDS = new Set([
  'edith', 'please', 'can', 'you', 'could', 'would', 'hey', 'hi', 'hello',
  'find', 'search', 'locate', 'list', 'show', 'get', 'fetch', 'check',
  'me', 'my', 'the', 'a', 'an', 'all', 'for', 'with', 'in', 'from', 'on', 'of', 'to', 'into', 'and', 'or', 'it', 'them', 'this', 'that', 'these',
  'create', 'make', 'generate', 'build', 'prepare', 'write', 'save', 'store', 'export', 'put',
  'summary', 'summarize', 'summarise', 'report', 'overview',
  'file', 'files', 'folder', 'folders', 'directory', 'directories',
  'named', 'called', 'titled', 'containing', 'about'
]);

const SINGULAR_MAP = new Map([
  ['invoices', 'invoice'],
  ['bills', 'bill'],
  ['reports', 'report'],
  ['resumes', 'resume'],
  ['receipts', 'receipt'],
  ['documents', 'document'],
  ['contracts', 'contract'],
  ['statements', 'statement'],
  ['notes', 'note'],
  ['logs', 'log'],
  ['screenshots', 'screenshot'],
  ['images', 'image'],
  ['photos', 'photo'],
  ['spreadsheets', 'spreadsheet']
]);

const APP_ALIASES = [
  { appId: 'vscode', displayName: 'Visual Studio Code', regex: /\b(?:vs\s*code|vscode|visual\s+studio\s+code)\b/i },
  { appId: 'notepad', displayName: 'Notepad', regex: /\bnotepad\b/i },
  { appId: 'calculator', displayName: 'Calculator', regex: /\b(?:calculator|calc)\b/i },
  { appId: 'explorer', displayName: 'File Explorer', regex: /\b(?:file\s+explorer|windows\s+explorer|explorer)\b/i },
  { appId: 'edge', displayName: 'Microsoft Edge', regex: /\b(?:microsoft\s+edge|msedge|edge)\b/i },
  { appId: 'paint', displayName: 'Paint', regex: /\b(?:ms\s*paint|mspaint|paint)\b/i }
];

function singularize(word) {
  return SINGULAR_MAP.get(word) || word;
}

function capitalizeWord(word) {
  if (!word) return 'Organized-Files';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function monthRangeFor(monthName, yearHint, now = new Date()) {
  const idx = MONTHS.indexOf(monthName.toLowerCase());
  if (idx === -1) return null;
  const currentYear = now.getUTCFullYear();
  let year = yearHint ? Number(yearHint) : currentYear;
  if (!yearHint && idx > now.getUTCMonth()) {
    year -= 1;
  }
  const monthNum = idx + 1;
  const start = `${year}-${String(monthNum).padStart(2, '0')}-01`;
  const end = monthNum === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(monthNum + 1).padStart(2, '0')}-01`;
  const endInclusive = new Date(Date.parse(end + 'T00:00:00Z') - 1).toISOString();
  return {
    month: MONTHS[idx],
    year,
    after: new Date(Date.parse(start + 'T00:00:00Z')).toISOString(),
    before: endInclusive
  };
}

function slugifyFileName(parts, suffix = 'summary-report') {
  const base = parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${base || 'edith'}-${suffix}.md`;
}

function extractAuthorizedFolderMention(lower) {
  const m = lower.match(/\b(?:in|from|into|to|on)\s+(?:my\s+)?(downloads|documents|desktop|pictures|videos|onedrive)\b/i);
  return m ? m[1] : null;
}

export function classifyIntent(prompt = '', nowOrOpts = new Date(), maybeOpts = {}) {
  const opts = nowOrOpts instanceof Date ? maybeOpts : (nowOrOpts || {});
  const now = nowOrOpts instanceof Date ? nowOrOpts : new Date();
  const selectedDocumentIds = Array.isArray(opts.documentIds) && opts.documentIds.length ? opts.documentIds : null;
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();

  // Check explicit Document Intelligence (Phase C) intents first
  const wantsSaveReportExplicit = /\b(?:save|write|store|export)\b/i.test(lower) || /\bcreate\s+(?:a|an|the)?\s*summary\s+report\b/i.test(lower);

  if (/\b(?:using\s+only\s+(?:these\s+)?selected\s+documents?|selected\s+documents?\s+only)\b/i.test(lower)) {
    const qClean = text.replace(/\b(?:using\s+only\s+(?:these\s+)?selected\s+documents?|answer\s+my\s+question)\b[:,-]*/gi, '').trim() || text;
    return {
      intent: 'knowledge_qa',
      question: qClean,
      selectedOnly: true,
      documentIds: selectedDocumentIds
    };
  }

  if (/\bcompare\b/i.test(lower) && /\b(?:offer\s+letters?|contracts?|documents?|letters?|proposals?|policies?|bills?|invoices?|files?)\b/i.test(lower)) {
    let query = lower
      .replace(/\b(?:edith|please|can|you|compare|these|those|two|three|the|all|my|with|and)\b/gi, ' ')
      .replace(/[^a-z0-9\s._-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map(singularize)
      .join(' ');
    return {
      intent: 'knowledge_compare',
      subjectQuery: query || 'offer letter',
      documentIds: selectedDocumentIds
    };
  }

  if (/\bextract\b.*\btables?\b/i.test(lower)) {
    const extensions = /\bpdfs?\b/i.test(lower) ? ['pdf'] : /\b(?:docx|word)\b/i.test(lower) ? ['docx'] : /\b(?:xlsx|excel|csv)\b/i.test(lower) ? ['xlsx', 'csv'] : null;
    return {
      intent: 'knowledge_extract_tables',
      extensions,
      folder: extractAuthorizedFolderMention(lower),
      documentIds: selectedDocumentIds
    };
  }

  const mentionMatch =
    text.match(/\b(?:documents?|files?|pdfs?|invoices?|bills?|contracts?)\s+(?:mentioning|containing|that\s+mention|that\s+contain|with)\s+(.+)$/i) ||
    text.match(/\bfind\s+(?:the\s+)?(?:invoice|bill|document|file|pdf)\s+(?:containing|mentioning|with)\s+(?:the\s+amount\s+|this\s+amount\s+)?(.+)$/i);
  if (mentionMatch) {
    const cleanNeedle = mentionMatch[1].replace(/[.?!]+$/, '').replace(/^(?:about|the\s+amount|amount)\s+/i, '').trim();
    const isInvoice = /\b(?:invoice|bill)\b/i.test(lower);
    return {
      intent: 'knowledge_mention_search',
      mentionQuery: cleanNeedle,
      searchQuery: isInvoice ? 'invoice' : '',
      documentIds: selectedDocumentIds
    };
  }

  if (
    !wantsSaveReportExplicit &&
    /\b(?:summari[sz]e|summary)\b/i.test(lower) &&
    /\b(?:bill|invoice|pdf|document|contract|offer|resume|letter|downloaded|docx|xlsx|csv|receipt|electricity|statement)\b/i.test(lower)
  ) {
    const isYesterday = /\byesterday\b/i.test(lower);
    let modifiedAfter = null;
    let modifiedBefore = null;
    if (isYesterday) {
      const y = new Date(now.getTime() - 86400000);
      const dayStr = y.toISOString().slice(0, 10);
      modifiedAfter = `${dayStr}T00:00:00.000Z`;
      modifiedBefore = `${dayStr}T23:59:59.999Z`;
    }
    const extensions = /\bpdfs?\b/i.test(lower) ? ['pdf'] : null;
    const words = lower
      .replace(/\b(?:edith|please|can|you|summari[sz]e|summary|of|the|my|latest|newest|downloaded|yesterday|today|from|in|this)\b/gi, ' ')
      .replace(/[^a-z0-9\s._-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .map(singularize);
    const subjectQuery = words.filter((w) => !['pdf', 'document', 'file'].includes(w)).join(' ');
    return {
      intent: 'knowledge_summarize',
      subjectQuery,
      extensions,
      modifiedAfter,
      modifiedBefore,
      folder: extractAuthorizedFolderMention(lower),
      latest: /\b(?:latest|newest)\b/i.test(lower) || isYesterday,
      documentIds: selectedDocumentIds
    };
  }

  if (selectedDocumentIds && /\b(?:what|when|who|where|how|why|which|tell|answer|does|is|are)\b/i.test(lower)) {
    return {
      intent: 'knowledge_qa',
      question: text,
      selectedOnly: true,
      documentIds: selectedDocumentIds
    };
  }

  // Check duplicate file detection (read-only analysis)
  if (/\bduplicates?\b/i.test(lower) && !/\bcopy\b.*\bfile\b/i.test(lower)) {
    const folder = extractAuthorizedFolderMention(lower);
    const subjMatch = lower.match(/\bduplicates?\s+(?:of\s+)?(?:my\s+)?([a-z0-9_-]{3,30})/i);
    let nameFilter = subjMatch ? singularize(subjMatch[1].toLowerCase()) : null;
    if (nameFilter && ['file', 'files', 'item', 'items', 'document', 'documents', 'but', 'without'].includes(nameFilter)) {
      nameFilter = null;
    }
    return {
      intent: 'companion_duplicates',
      folder,
      nameFilter,
      readOnly: true
    };
  }

  // Check large file scan
  if (/\b(?:large|largest|biggest)\s+files?\b/i.test(lower) && !/\b(?:report|summary|summarize|summarise)\b/i.test(lower)) {
    const folder = extractAuthorizedFolderMention(lower);
    const sizeMatch = lower.match(/\b(?:over|above|greater\s+than|at\s+least|>=?)\s+(\d+(?:\.\d+)?)\s*(kb|mb|gb)\b/i);
    let minSizeBytes = null;
    if (sizeMatch) {
      const mult = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[sizeMatch[2].toLowerCase()];
      minSizeBytes = Math.max(1024, Math.round(Number(sizeMatch[1]) * mult));
    }
    return {
      intent: 'companion_large_files',
      folder,
      minSizeBytes
    };
  }

  // Check organize workflow (e.g., "organize the PDF invoices in my Downloads folder")
  if (/\b(?:organize|organise)\b/i.test(lower)) {
    const folder = extractAuthorizedFolderMention(lower) || 'Downloads';
    const extensions = /\bpdfs?\b/i.test(lower)
      ? ['pdf']
      : /\b(?:screenshots?|images?|photos?|pictures?)\b/i.test(lower)
        ? ['png', 'jpg', 'jpeg']
        : null;
    let cleaned = lower
      .replace(/\b(?:in|from|into)\s+(?:my\s+)?(downloads|documents|desktop|pictures|videos|onedrive)\b/gi, ' ')
      .replace(/\b(?:edith|please|can|you|organize|organise|folder|directory|files?|pdfs?|all|my|the)\b/gi, ' ');
    const tokens = cleaned
      .replace(/[^a-z0-9\s._-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .map(singularize);
    const subjectWord = tokens[0] || (extensions?.[0] === 'pdf' ? 'document' : 'organized');
    const targetSubFolder = subjectWord === 'invoice'
      ? 'Invoices'
      : subjectWord === 'receipt'
        ? 'Receipts'
        : subjectWord === 'screenshot'
          ? 'Screenshots'
          : `${capitalizeWord(subjectWord)}s`;
    return {
      intent: 'companion_organize_files',
      folder,
      searchQuery: tokens.join(' ') || subjectWord,
      extensions,
      targetSubFolder
    };
  }

  // Check explicit single-file mutations ("rename X to Y", "move X to Y", "copy X to Y", "move X to recycle bin")
  const recycleMatch = text.match(/\b(?:recycle|send|move)\s+(?:file\s+)?["']?([A-Za-z0-9._ -]{2,80}?\.[a-z0-9]{1,10})["']?(?:\s+to\s+(?:the\s+)?(?:windows\s+)?recycle\s+bin|\s+in\s+(?:downloads|documents))/i)
    || (/\brecycle\s+bin\b/i.test(lower) && text.match(/["']?([A-Za-z0-9._ -]{2,80}?\.[a-z0-9]{1,10})["']?/i));
  if (recycleMatch && /\b(?:recycle|trash)\b/i.test(lower)) {
    return {
      intent: 'companion_file_mutation',
      mutation: 'recycle_file',
      targetQuery: recycleMatch[1].trim(),
      folder: extractAuthorizedFolderMention(lower)
    };
  }

  const renameMatch = text.match(/\brename\s+(?:the\s+file\s+|file\s+)?["']?([A-Za-z0-9._ -]{2,80})["']?\s+to\s+["']?([A-Za-z0-9._ -]{2,80})["']?/i);
  if (renameMatch) {
    return {
      intent: 'companion_file_mutation',
      mutation: 'rename_file',
      targetQuery: renameMatch[1].trim(),
      newName: renameMatch[2].trim(),
      folder: extractAuthorizedFolderMention(lower)
    };
  }

  const moveOrCopyMatch = text.match(/\b(move|copy)\s+(?:the\s+file\s+|file\s+)?["']?([A-Za-z0-9._ -]{2,80}?\.[a-z0-9]{1,10})["']?\s+(?:to|into)\s+(?:my\s+)?(downloads|documents|desktop|pictures|videos|onedrive)(?:\s+(?:folder|directory))?/i);
  if (moveOrCopyMatch) {
    return {
      intent: 'companion_file_mutation',
      mutation: moveOrCopyMatch[1].toLowerCase() === 'copy' ? 'copy_file' : 'move_file',
      targetQuery: moveOrCopyMatch[2].trim(),
      targetFolder: capitalizeWord(moveOrCopyMatch[3])
    };
  }

  // Check approved application launching (e.g., "open VS Code", "launch Notepad", "open cmd")
  const hasRevealPhrase = /\b(?:reveal|show\s+in\s+explorer|show\s+in\s+folder)\b/i.test(lower);
  const hasFileSelector = /\b(?:open|launch)\s+(?:the\s+)?(?:first|second|third|1st|2nd|3rd|newest|oldest|selected|file|folder|result|report)\b/i.test(lower);
  if (!hasRevealPhrase && !hasFileSelector && /\b(?:open|launch|start)\b/i.test(lower)) {
    const matchedApp = APP_ALIASES.find((app) => app.regex.test(text));
    if (matchedApp) {
      return {
        intent: 'companion_launch_app',
        appId: matchedApp.appId,
        displayName: matchedApp.displayName
      };
    }
    if (/\b(?:launch|open)\s+(?:app|application|program)\s+([a-z0-9_.-]{2,32})\b/i.test(lower)) {
      const m = lower.match(/\b(?:launch|open)\s+(?:app|application|program)\s+([a-z0-9_.-]{2,32})\b/i);
      return { intent: 'companion_launch_app', appId: m[1], displayName: m[1] };
    }
    if (/\b(?:open|launch)\s+(cmd|powershell|pwsh|terminal|bash|wsl|regedit)\b/i.test(lower)) {
      const m = lower.match(/\b(?:open|launch)\s+(cmd|powershell|pwsh|terminal|bash|wsl|regedit)\b/i);
      return { intent: 'companion_launch_app', appId: m[1], displayName: m[1] };
    }
  }

  if (/\b(?:installed\s+apps?|approved\s+apps?|what\s+apps?\s+can\s+you\s+open)\b/i.test(lower)) {
    return { intent: 'companion_apps_list' };
  }

  // Check running processes / top RAM or CPU usage
  const wantsProcesses =
    (/\b(?:processes?|apps?|applications?|programs?)\b/i.test(lower) && /\b(?:ram|memory|cpu|processor|consuming|consume|most|top|highest)\b/i.test(lower)) ||
    /\b(?:running\s+processes?|top\s+(?:ram|memory|cpu)|consume\s+the\s+most\s+(?:ram|memory|cpu))\b/i.test(lower);
  if (wantsProcesses) {
    const sortBy = /\b(?:cpu|processor)\b/i.test(lower) && !/\b(?:ram|memory)\b/i.test(lower) ? 'cpu' : 'memory';
    return { intent: 'companion_processes', sortBy, limit: 10 };
  }

  // Check system metrics: specific drive storage, battery, CPU, RAM usage
  const driveLetterMatch = lower.match(/\b(?:on|in|for)?\s*([a-z])(?::)?\s+drive\b/i) || lower.match(/\bdrive\s+([a-z]):?\b/i);
  const wantsStorageTelemetry =
    (Boolean(driveLetterMatch) && /\b(?:storage|space|free|left|capacity|full|size)\b/i.test(lower)) ||
    /\b(?:battery|cpu|ram|memory\s+usage|system\s+metrics|system\s+health|disk\s+utilization)\b/i.test(lower);
  if (wantsStorageTelemetry && !/\b(?:company|business|service|price|contact|booking|report)\b/i.test(lower)) {
    return {
      intent: 'companion_system_metrics',
      drive: driveLetterMatch ? driveLetterMatch[1].toUpperCase() : null,
      focus: driveLetterMatch ? 'storage' : /\bbattery\b/i.test(lower) ? 'battery' : 'system'
    };
  }

  const saveFolderMatch = text.match(
    /\b(?:save|write|store|export|put)\b[^.?!]*?\b(?:in|to|into)\s+(?:my\s+)?([A-Za-z][A-Za-z0-9 _-]{1,40}?)(?:\s+(?:folder|directory)|\s*$|[.,;!?])/i
  );

  // Strip save/report clauses before extracting search folder & filename keywords
  let searchClause = lower
    .replace(/\b(?:and\s+)?(?:save|write|store|export|put)\b.*$/i, ' ')
    .replace(/\b(?:and\s+)?(?:create|make|generate|prepare)\s+(?:a|an|the)?\s*(?:summary|report|overview).*$/i, ' ');
  const searchFolderMatch = searchClause.match(
    /\b(?:find|search|locate|list|summarize|summarise)\b[^.?!]*?\b(?:in|from)\s+(?:my\s+)?(downloads|documents|desktop|pictures|videos|onedrive)\b/i
  );

  const targetFolder = saveFolderMatch ? saveFolderMatch[1].trim() : null;
  const searchFolder = searchFolderMatch ? searchFolderMatch[1].trim() : null;

  const monthMatch = lower.match(new RegExp(`\\b(${MONTHS.join('|')})(?:\\s+(20\\d{2}))?\\b`));
  const monthRange = monthMatch ? monthRangeFor(monthMatch[1], monthMatch[2], now) : null;

  const wantsSave = /\b(?:save|write|store|export)\b/i.test(lower);
  const wantsReport = /\b(?:report|summary|summarize|summarise)\b/i.test(lower);
  const hasFileSubject = /\b(?:files?|invoices?|bills?|receipts?|resumes?|documents?|pdfs?|csvs?|logs?|notes?|contracts?|statements?|reports?|spreadsheets?|excel|downloads|folders?|screenshots?)\b/i.test(lower);
  const hasSearchVerb = /\b(?:find|search|locate|list|show|get)\b/i.test(lower);

  if (searchFolder) {
    searchClause = searchClause.replace(new RegExp(`\\b(?:in|from)\\s+(?:my\\s+)?${searchFolder.toLowerCase()}\\b`, 'g'), ' ');
  }
  const rawWords = searchClause
    .replace(/[^a-z0-9\s._-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(singularize)
    .filter((w) => !STOP_WORDS.has(w) && w.length > 1);

  const uniqueWords = [...new Set(rawWords)];
  const coreWords = uniqueWords.filter((w) => !MONTHS.includes(w) && !/^20\d{2}$/.test(w));

  const searchQuery = uniqueWords.join(' ');
  const coreSubject = coreWords.join(' ');

  if (/\b(?:index|indexing|scan|scanning)\b/i.test(lower) && !wantsReport) {
    let indexAction = 'status';
    if (/\bstart\b/i.test(lower)) indexAction = 'start';
    else if (/\bpause\b/i.test(lower)) indexAction = 'pause';
    else if (/\bresume\b/i.test(lower)) indexAction = 'resume';
    else if (/\bcancel\b/i.test(lower)) indexAction = 'cancel';
    return { intent: 'index_manage', indexAction, searchQuery: '', coreSubject: '' };
  }

  if (/\b(?:drive|drives|disk|storage)\b/i.test(lower) && !wantsReport) {
    return { intent: 'drive_info', searchQuery: '', coreSubject: '' };
  }

  if (wantsReport && (hasFileSubject || hasSearchVerb || uniqueWords.length > 0)) {
    const slugSeed = [...coreWords.slice(0, 3), ...(monthRange ? [monthRange.month] : [])];
    return {
      intent: 'file_report',
      searchQuery: searchQuery || coreSubject || 'invoice',
      coreSubject: coreSubject || searchQuery || 'invoice',
      monthRange,
      searchFolder,
      targetFolder,
      wantsSave: wantsSave || /\bcreate\b.*\breport\b/i.test(lower),
      reportFileName: slugifyFileName(slugSeed, 'summary')
    };
  }

  if (hasSearchVerb && hasFileSubject) {
    return {
      intent: 'file_search',
      searchQuery: searchQuery || text.slice(0, 80),
      coreSubject,
      monthRange,
      searchFolder
    };
  }

  if (/\b(?:open|reveal|show in explorer|show in folder)\b/i.test(lower)) {
    let selector = 'selected';
    if (/\bfirst\b|\b1st\b|\b1\b/.test(lower)) selector = '1';
    else if (/\bsecond\b|\b2nd\b|\b2\b/.test(lower)) selector = '2';
    else if (/\bthird\b|\b3rd\b|\b3\b/.test(lower)) selector = '3';
    else if (/\bnewest\b|\blatest\b/.test(lower)) selector = 'newest';
    else if (/\boldest\b/.test(lower)) selector = 'oldest';
    return {
      intent: 'file_action',
      action: /\breveal|explorer|folder\b/i.test(lower) ? 'reveal_in_folder' : 'open_file',
      selector
    };
  }

  if (/\b(?:company|business|address|service|services|price|prices|contact|contacts|appointment|appointments|booking|bookings|availability|schedule|slots?)\b/i.test(lower)) {
    return { intent: 'business_info' };
  }

  return { intent: 'general_assistant' };
}

export function buildTaskPlan(prompt, parsed, { authorizedFolders = [] } = {}) {
  switch (parsed.intent) {
    case 'knowledge_compare':
      return [
        { title: 'Locate and index authorized documents for comparison', toolName: null, riskLevel: 'READ_ONLY', kind: 'knowledge_sync' },
        { title: 'Compare selected documents locally with source citations', toolName: 'knowledge_compare', riskLevel: 'READ_ONLY', kind: 'knowledge_compare' }
      ];
    case 'knowledge_extract_tables':
      return [
        { title: 'Locate and index authorized documents containing tables', toolName: null, riskLevel: 'READ_ONLY', kind: 'knowledge_sync' },
        { title: 'Extract structured tables locally', toolName: 'knowledge_extract_tables', riskLevel: 'READ_ONLY', kind: 'knowledge_extract_tables' }
      ];
    case 'knowledge_mention_search':
      return [
        { title: 'Ensure authorized local documents are parsed and indexed locally', toolName: null, riskLevel: 'READ_ONLY', kind: 'knowledge_sync' },
        { title: `Search document contents for "${parsed.mentionQuery}"`, toolName: 'knowledge_search', riskLevel: 'READ_ONLY', kind: 'knowledge_mention_search' }
      ];
    case 'knowledge_summarize':
      return [
        { title: 'Locate and parse matching local documents privately', toolName: null, riskLevel: 'READ_ONLY', kind: 'knowledge_sync' },
        { title: 'Summarize document contents locally with citations', toolName: 'knowledge_summarize', riskLevel: 'READ_ONLY', kind: 'knowledge_summarize' }
      ];
    case 'knowledge_qa':
      return [
        { title: 'Answer question locally using grounded citations from scoped documents', toolName: 'knowledge_answer', riskLevel: 'READ_ONLY', kind: 'knowledge_qa' }
      ];
    case 'companion_launch_app':
      return [
        { title: 'Check approved Windows applications catalog', toolName: 'list_installed_apps', riskLevel: 'READ_ONLY', kind: 'companion_apps' },
        { title: `Launch ${parsed.displayName} after confirmation`, toolName: 'launch_approved_app', riskLevel: 'REVERSIBLE', kind: 'companion_launch_app' }
      ];
    case 'companion_apps_list':
      return [
        { title: 'Inspect installed approved Windows applications', toolName: 'list_installed_apps', riskLevel: 'READ_ONLY', kind: 'companion_apps' }
      ];
    case 'companion_processes':
      return [
        { title: 'Read live CPU and memory usage', toolName: 'get_system_metrics', riskLevel: 'READ_ONLY', kind: 'companion_metrics' },
        { title: `Inspect top running processes by ${parsed.sortBy || 'memory'}`, toolName: 'list_running_processes', riskLevel: 'READ_ONLY', kind: 'companion_processes' }
      ];
    case 'companion_system_metrics':
      return [
        { title: parsed.drive ? `Check ${parsed.drive}: drive storage and system telemetry` : 'Collect paired PC CPU, RAM, storage, and battery metrics', toolName: 'get_system_metrics', riskLevel: 'READ_ONLY', kind: 'companion_metrics' }
      ];
    case 'companion_duplicates':
      return [
        { title: 'Scan authorized folders for SHA-256 duplicate candidates (read-only)', toolName: 'find_duplicate_files', riskLevel: 'READ_ONLY', kind: 'companion_duplicates' }
      ];
    case 'companion_large_files':
      return [
        { title: 'Scan authorized folders for large files (read-only)', toolName: 'find_large_files', riskLevel: 'READ_ONLY', kind: 'companion_large_files' }
      ];
    case 'companion_organize_files': {
      const folderLabel = parsed.folder || authorizedFolders[0]?.id || 'Downloads';
      return [
        { title: `Search ${folderLabel} for matching files`, toolName: 'search_files', riskLevel: 'READ_ONLY', kind: 'organize_search' },
        { title: `Ensure target subfolder "${parsed.targetSubFolder}" exists in ${folderLabel}`, toolName: 'create_directory', riskLevel: 'REVERSIBLE', kind: 'organize_mkdir' },
        { title: `Move matched files into ${folderLabel}/${parsed.targetSubFolder}`, toolName: 'move_file', riskLevel: 'REVERSIBLE', kind: 'organize_move' },
        { title: 'Verify organized files and reversible undo records', toolName: null, riskLevel: 'READ_ONLY', kind: 'organize_verify' }
      ];
    }
    case 'companion_file_mutation':
      return [
        { title: `Locate "${parsed.targetQuery}" in authorized folders`, toolName: 'search_files', riskLevel: 'READ_ONLY', kind: 'mutate_search' },
        { title: `Execute confirmed ${parsed.mutation.replace(/_/g, ' ')}`, toolName: parsed.mutation, riskLevel: 'REVERSIBLE', kind: 'companion_mutate' }
      ];
    case 'file_report': {
      const steps = [
        { title: 'Search authorized folders for matching files', toolName: 'search_files', riskLevel: 'READ_ONLY', kind: 'search' },
        { title: 'Read supported local text files', toolName: 'read_local_text', riskLevel: 'READ_ONLY', kind: 'read_local' },
        { title: 'Compose summary report preview', toolName: null, riskLevel: 'READ_ONLY', kind: 'compose_report' }
      ];
      if (parsed.wantsSave) {
        const folderLabel = parsed.targetFolder || authorizedFolders[0]?.id || 'Downloads';
        steps.push(
          { title: `Save report "${parsed.reportFileName}" to ${folderLabel}`, toolName: 'save_report', riskLevel: 'REVERSIBLE', kind: 'save_report' },
          { title: 'Verify saved report exists on disk', toolName: null, riskLevel: 'READ_ONLY', kind: 'verify_report' }
        );
      }
      return steps;
    }
    case 'file_search':
      return [
        { title: 'Search authorized local folders', toolName: 'search_files', riskLevel: 'READ_ONLY', kind: 'search' }
      ];
    case 'file_action':
      return [
        { title: 'Resolve target file reference', toolName: 'resolve_file_reference', riskLevel: 'READ_ONLY', kind: 'resolve_ref' },
        { title: 'Execute local file action', toolName: parsed.action || 'open_file', riskLevel: 'READ_ONLY', kind: 'file_act' }
      ];
    case 'index_manage':
      return [
        {
          title: parsed.indexAction === 'status' ? 'Check local file index status' : `Run index action (${parsed.indexAction})`,
          toolName: parsed.indexAction === 'status' ? 'get_index_status' : 'index_control',
          riskLevel: 'READ_ONLY',
          kind: 'index'
        }
      ];
    case 'drive_info':
      return [
        { title: 'Inspect fixed drive metadata', toolName: 'get_drive_information', riskLevel: 'READ_ONLY', kind: 'drives' }
      ];
    case 'business_info':
      return [
        { title: 'Inspect active company profile, services & bookings', toolName: null, riskLevel: 'READ_ONLY', kind: 'business_summary' }
      ];
    default:
      return [
        { title: 'Analyze request and prepare grounded response', toolName: null, riskLevel: 'READ_ONLY', kind: 'general' }
      ];
  }
}

export function isLocalTextFile(name) {
  return LOCAL_TEXT_EXTENSIONS.has(path.extname(String(name || '')).toLowerCase());
}

export function composeLocalReport({ prompt, matches, readItems, skippedFiles }) {
  const lines = [
    '# EDITH OS Summary Report',
    '',
    `- **Generated:** ${new Date().toISOString()}`,
    `- **Request:** ${prompt}`,
    `- **Matching files found:** ${matches.length}`,
    `- **Local text files read:** ${readItems.length}`,
    `- **Metadata-only / skipped files:** ${skippedFiles.length}`,
    ''
  ];

  if (!matches.length) {
    lines.push('No authorized files matched the search request.');
    return lines.join('\n');
  }

  lines.push('## Matched Files', '');
  for (const [idx, item] of matches.entries()) {
    lines.push(`${idx + 1}. **${item.name}** (${item.rootId}, ${item.size} bytes, modified ${item.modifiedAt})`);
  }
  lines.push('');

  if (readItems.length) {
    lines.push('## Extracted Content Summary', '');
    for (const doc of readItems) {
      lines.push(`### ${doc.name}`);
      const contentLines = doc.excerpt
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const amountLines = contentLines.filter((l) =>
        /\b(?:total|amount|due|balance|subtotal|tax|paid|invoice|date|vendor|from|bill)\b|[$£€₹]/i.test(l)
      );
      const chosen = (amountLines.length ? amountLines : contentLines).slice(0, 8);
      if (!chosen.length) {
        lines.push('- *(Empty text file)*');
      } else {
        for (const entry of chosen) {
          lines.push(`- ${entry.slice(0, 220)}`);
        }
      }
      if (doc.truncated) {
        lines.push('- *(Excerpt truncated to bounded reading limit)*');
      }
      lines.push('');
    }
  }

  if (skippedFiles.length) {
    lines.push('## Non-Text / Metadata-Only Files', '');
    for (const item of skippedFiles) {
      lines.push(`- **${item.name}** (${item.extension || 'unknown'} — metadata only; structured parsers arrive in Milestone 3)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
