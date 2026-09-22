// WHICH URLS GET QUEUED, AND WHY NOT.
//
// Run with: node hiringcafe-scraper/csv-lazyapply.test.cjs
//
// A CSV of 153 real search URLs was uploaded and came back "0 supported".
// The file had parsed perfectly -- header found, URL column found, all
// 153 rows read. It returned zero because every URL was a google.com
// search page and isSupported() only queues job postings. The count
// alone could not tell those apart from a file that failed to parse, and
// there was nothing else on screen to go on.
//
// Two things came out of that. The patterns now cover every host form
// each platform actually ships, because listing only some of them counts
// a live posting as unsupported. And the summary says what it turned
// away, because "0" with no reason is a dead end.
//
// The first attempt at the patterns introduced a worse bug than the one
// it fixed: isSupported() tested the whole URL string, so adding
// rippling-ats.com made every Google search URL match -- those searches
// contain "site:rippling-ats.com" in their query. 153 search pages would
// have been queued into LazyApply as if they were jobs. Hence the
// hostname parse, and hence this file.
//
// csv-lazyapply.js is an IIFE that touches the DOM on load, so the
// functions are lifted out by source range rather than required.
let PASS = 0, FAIL = 0;
const t = (n, c, x) => { c ? PASS++ : FAIL++; console.log((c ? '  PASS  ' : '  FAIL  ') + n + (c ? '' : '\n           >> ' + x)); };

const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'csv-lazyapply.js'), 'utf8');
const between = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b);
  if (i === -1 || j === -1 || j < i) throw new Error('could not lift ' + a + ' .. ' + b);
  return src.slice(i, j);
};
const M = new Function(
  between('  /** The host, so a URL', '  const els = {')
  + between('function parseCsv', 'async function readFiles')
  + '; return { isSupported, scanCsv, parseCsv, findUrlColumn };')();

console.log('EVERY HOST FORM THESE FOUR PLATFORMS SHIP IS A JOB');
{
  // Greenhouse's own API returns boards.greenhouse.io in absolute_url
  // while its current boards serve job-boards.greenhouse.io. Both are
  // the same posting. Only one used to be accepted.
  for (const url of [
    'https://boards.greenhouse.io/klaviyo/jobs/1234567',
    'https://job-boards.greenhouse.io/klaviyo/jobs/1234567',
    'https://boards.eu.greenhouse.io/acme/jobs/9',
    'https://job-boards.eu.greenhouse.io/acme/jobs/9',
    'https://jobs.lever.co/matillion/abc-123',
    'https://jobs.eu.lever.co/acme/abc-123',
    'https://jobs.ashbyhq.com/ramp/xyz',
    'https://ats.rippling.com/acme/jobs/5',
    'https://acme.rippling-ats.com/jobs/5',
    'https://rippling-ats.com/acme/jobs/5',
  ]) t('  ' + url.replace(/^https:\/\//, ''), M.isSupported(url), 'a live posting counted as unsupported');
}

console.log('\nAND EVERYTHING ELSE IS NOT');
{
  for (const url of [
    'https://www.linkedin.com/jobs/view/123',
    'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1',
    'https://jobs.smartrecruiters.com/acme/123',
    'https://www.indeed.com/viewjob?jk=1',
    'not-a-url',
    '',
  ]) t('  ' + (url || '(empty)').slice(0, 50), !M.isSupported(url), 'queued something it cannot drive');
}

console.log('\nAND A URL THAT ONLY MENTIONS A SUPPORTED DOMAIN IS NOT A JOB');
{
  // The bug the first fix introduced. A Boolean job search names every
  // board it searches, in its own query string.
  const search = 'https://www.google.com/search?q=(%22Risk%22)%20(site%3Agreenhouse.io%20OR'
    + '%20site%3Alever.co%20OR%20site%3Aashbyhq.com%20OR%20site%3Arippling-ats.com)';
  t('  a Boolean search naming all four boards', !M.isSupported(search), search.slice(0, 90));
  t('  ...and one naming the exact host', !M.isSupported(
    'https://www.google.com/search?q=site%3Ajob-boards.greenhouse.io'), 'a search page would be queued');
  t('  a redirector carrying one in its query', !M.isSupported(
    'https://example.com/out?to=https://jobs.lever.co/acme/1'), 'the host is example.com');
  t('  and a lookalike domain', !M.isSupported('https://jobs.lever.co.evil.com/acme/1'),
    'suffix attack: the host ends with evil.com');
}

console.log('\nTHE CSV ITSELF STILL READS THE WAY IT DID');
{
  const csv = 'url,board,company,title\r\n'
    + 'https://jobs.lever.co/matillion/abc,Lever,matillion,GRC_Analyst\r\n'
    + '"https://boards.greenhouse.io/klaviyo/jobs/1","Greenhouse","klaviyo","Risk Analyst, EMEA"\r\n';
  const r = M.scanCsv(csv);
  t('  the url column is found', r.column === 0, String(r.column));
  t('  both rows come through', r.urls.length === 2, JSON.stringify(r.urls));
  t('  ...including the quoted one with a comma in another field',
    r.urls.includes('https://boards.greenhouse.io/klaviyo/jobs/1'), JSON.stringify(r.urls));

  // The header this tool's own export writes.
  t('  "Job URL" is preferred when present',
    M.findUrlColumn(['Company', 'Job URL', 'Internal URL']) === 1,
    String(M.findUrlColumn(['Company', 'Job URL', 'Internal URL'])));
  t('  and a file with no header match scans every cell',
    M.scanCsv('https://jobs.ashbyhq.com/ramp/xyz\r\n').urls.length === 1,
    'a headerless list of URLs is a reasonable thing to hand it');
}

console.log('\nAND IT SAYS WHAT IT TURNED AWAY, NOT ONLY HOW MANY IT KEPT');
{
  const searches = 'url,board\r\n'
    + 'https://www.google.com/search?q=a,x\r\n'
    + 'https://www.google.com/search?q=b,x\r\n'
    + 'https://www.bing.com/search?q=c,x\r\n';
  const r = M.scanCsv(searches);
  t('  nothing supported', r.urls.length === 0, JSON.stringify(r.urls));
  t('  ...but the rows were read', r.rows === 3, String(r.rows));
  t('  ...and counted as rejected', r.rejected === 3, String(r.rejected));
  t('  ...and named, commonest first',
    r.hosts[0][0] === 'google.com' && r.hosts[0][1] === 2, JSON.stringify(r.hosts));

  // The three cases the old message could not distinguish.
  const empty = M.scanCsv('');
  t('  an empty file reads as no rows', empty.rows === 0 && empty.rejected === 0,
    JSON.stringify(empty));
  const noUrls = M.scanCsv('url,title\r\nnot a url,x\r\n');
  t('  rows with no URLs are not counted as rejections',
    noUrls.rows === 1 && noUrls.rejected === 0 && noUrls.hosts.length === 0,
    JSON.stringify(noUrls));
  t('  and a file of good URLs reports none rejected',
    M.scanCsv('url\r\nhttps://jobs.lever.co/a/1\r\n').rejected === 0, 'a false alarm');
}

console.log('\nAND THE SUMMARY ACTUALLY USES ANY OF THAT');
{
  t('  the per-file line reports skipped', /\$\{p\.rejected\} skipped/.test(src),
    'the count is collected and never shown');
  t('  the search-page case is named outright', /SEARCH pages, not job postings/.test(src),
    'the commonest cause of 0 would go unexplained');
  t('  the platforms it drives are listed', /Greenhouse, Lever, Ashby, Rippling/.test(src),
    'no way to know what it wanted instead');
  t('  the no-rows case is separate', /no readable rows/.test(src), 'a parse failure reads as 0 supported');
}

console.log('\nAND PRESSING THE BUTTON ALWAYS PRODUCES AN ANSWER');
{
  // Reported as "can't add the URLs to Add to LazyApply Queue". Two dead
  // ends met there. runQueue() opened with `if (running ||
  // !masterList.length) return;` -- a silent return -- and the button
  // was disabled whenever the list was empty, so pressing it did
  // nothing and said nothing, and an empty list looked exactly like a
  // broken extension.
  //
  // The second was subtler: with no LazyApply tab open, the run
  // announced "Adding 240 URL(s)" and then paused at 0/240 on the first
  // iteration, which reads as a crash rather than as a missing tab.
  const html = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  const btn = (html.match(/<button id="csv-start-btn"[^>]*>/) || [''])[0];
  t('  the button does not start life disabled', !/disabled/.test(btn), btn);
  t('  ...and is not disabled again when a file yields nothing',
    !/startBtn\.disabled = master(List)?\.length === 0/.test(src),
    'a dead button is the whole symptom');

  // Far enough in to reach the "Adding N URL(s)" announcement, which is
  // the line the tab check has to come before.
  const head = src.slice(src.indexOf('async function runQueue'),
    src.indexOf('async function runQueue') + 3000);
  t('  an empty list is explained, not swallowed',
    /Nothing loaded to add/.test(head) && !/if \(running \|\| !masterList\.length\) return;/.test(src),
    'the silent return is still there');
  t('  ...and it names what the file should have held',
    /Greenhouse,/.test(head) && /search URLs will not do it/.test(head),
    'no way to know what was wrong with the file');
  t('  a missing LazyApply tab is caught before the run is announced',
    head.indexOf('No LazyApply tab is open') < head.indexOf('▶ Adding'),
    'it would print "Adding N URL(s)" and then immediately pause at 0');
  t('  ...and says where to open it',
    /app\.lazyapply\.com\/dashboard/.test(head), 'nowhere to go from the message');
  t('  the run still guards against double-starting',
    /if \(running\) return;/.test(head), 'a second click would start a parallel run');
}

console.log('\nANY JOB-URL CSV SHAPE WORKS');
{
  const loose = 'Company,Notes,Link\r\n'
    + 'Acme,"see https://job-boards.greenhouse.io/acme/jobs/1?gh_src=Simplify and more",x\r\n'
    + 'Beta,,http://jobs.lever.co/beta/abc-1/\r\n'
    + 'Gamma,,https://www.google.com/url?q=https://jobs.ashbyhq.com/gamma/uuid-9&sa=U\r\n'
    + 'Dup,,https://job-boards.greenhouse.io/acme/jobs/1\r\n'
    + 'Board home,,https://jobs.lever.co/beta\r\n';
  const r = M.scanCsv(loose);
  t('  URLs found in any column, inside text', r.urls.includes('https://job-boards.greenhouse.io/acme/jobs/1'), JSON.stringify(r.urls));
  t('  http and trailing slash normalised', r.urls.includes('https://jobs.lever.co/beta/abc-1'), JSON.stringify(r.urls));
  t('  redirect wrappers unwrapped', r.urls.includes('https://jobs.ashbyhq.com/gamma/uuid-9'), JSON.stringify(r.urls));
  t('  the same job reached two ways is queued once', r.urls.length === 3, JSON.stringify(r.urls));
  t('  a board home page is not a job', !r.urls.some((u) => /lever\.co\/beta$/.test(u)), JSON.stringify(r.urls));
  t('  a headerless plain list works', M.scanCsv('https://jobs.ashbyhq.com/a/b\nhttps://jobs.lever.co/c/d\n').urls.length === 2, 'plain list');
  t('  several links in one cell', M.scanCsv('links\r\n"https://jobs.ashbyhq.com/a/b | https://jobs.lever.co/c/d"\r\n').urls.length === 2, 'multi-link cell');
  const srch = M.scanCsv('platform,url\r\nx,https://www.google.com/search?q=site%3Agreenhouse.io\r\n');
  t('  a search page is still NOT a job', srch.urls.length === 0 && srch.rejected === 1, JSON.stringify(srch));
}

console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
