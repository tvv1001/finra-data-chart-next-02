#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const NATIONAL = path.join(DATA_DIR, 'national');
const EXTERNAL = path.join(DATA_DIR, 'external');
const FINRA = path.join(NATIONAL, 'brokercheck.finra.org');
const SEC = path.join(NATIONAL, 'adviserinfo.sec.gov');

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; research-tool/1.0)', Accept: 'application/json' };

function finraFirmUrl(id) { return `https://api.brokercheck.finra.org/search/firm/${encodeURIComponent(id)}?hl=true&nrows=12&wt=json`; }
function finraIndividualUrl(id) { return `https://api.brokercheck.finra.org/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&wt=json`; }
function secFirmUrl(id) { return `https://api.adviserinfo.sec.gov/search/firm?query=${encodeURIComponent(id)}&hl=true&nrows=12&start=0&wt=json`; }
function secIndividualUrl(id) { return `https://api.adviserinfo.sec.gov/search/individual/${encodeURIComponent(id)}?hl=true&includePrevious=true&nrows=12&wt=json`; }

async function ensureDirs() {
  await fs.mkdir(EXTERNAL, { recursive: true });
  await fs.mkdir(FINRA, { recursive: true });
  await fs.mkdir(SEC, { recursive: true });
}

async function readJsonSafe(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf-8')); } catch { return null; }
}

function extractIds(json) {
  const firms = new Set();
  const inds = new Set();
  try {
    const hits = json?.hits?.hits || [];
    for (const h of hits) {
      const src = h._source || {};
      if (src.firm_id) firms.add(String(src.firm_id));
      if (src.firmId) firms.add(String(src.firmId));
      if (src.firm_bd_sec_number) firms.add(String(src.firm_bd_sec_number));
      if (src.ind_source_id) inds.add(String(src.ind_source_id));
      if (src.person?.crd) inds.add(String(src.person.crd));
      if (Array.isArray(src.ind_current_employments)) for (const e of src.ind_current_employments) if (e.firmId) firms.add(String(e.firmId));
      if (Array.isArray(src.ind_ia_current_employments)) for (const e of src.ind_ia_current_employments) if (e.firmId) firms.add(String(e.firmId));
      if (src.content) {
        try {
          const c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
          if (c?.basicInformation?.individualId) inds.add(String(c.basicInformation.individualId));
          if (c?.basicInformation?.crd) inds.add(String(c.basicInformation.crd));
          if (Array.isArray(c?.currentEmployments)) for (const e of c.currentEmployments) if (e.firmId) firms.add(String(e.firmId));
        } catch {}
      }
    }
  } catch {}
  return { firms, inds };
}

async function gatherSeedIds() {
  const firms = new Set();
  const inds = new Set();
  const dirs = [FINRA, SEC, EXTERNAL];
  for (const d of dirs) {
    try {
      const files = await fs.readdir(d);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const j = await readJsonSafe(path.join(d, f));
        if (!j) continue;
        const { firms: fset, inds: iset } = extractIds(j);
        for (const id of fset) firms.add(id);
        for (const id of iset) inds.add(id);
      }
    } catch {}
  }
  return { firms, inds };
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAndWrite(url, externalName, nationalPath) {
  try {
    const r = await axios.get(url, { headers: HEADERS, timeout: 20000 });
    const txt = JSON.stringify(r.data, null, 2);
    if (externalName) await fs.writeFile(path.join(EXTERNAL, externalName), txt, 'utf-8');
    if (nationalPath) await fs.writeFile(nationalPath, txt, 'utf-8');
    return { ok: true };
  } catch (e) {
    const status = e?.response?.status;
    const retryAfter = e?.response?.headers?.['retry-after'];
    if (status === 429) {
      const ra = retryAfter ? Number(retryAfter) : null;
      console.warn('fetch rate-limited (429)', url, retryAfter ? `(Retry-After: ${retryAfter}s)` : '');
      return { ok: false, retryAfter: ra };
    }
    console.warn('fetch failed', url, e.message);
    // If https failed, try falling back to http (some endpoints may accept http)
    try {
      if (url.startsWith('https://')) {
        const httpUrl = 'http://' + url.slice(8);
        console.log('Retrying with http:', httpUrl);
        const r2 = await axios.get(httpUrl, { headers: HEADERS, timeout: 20000 });
        const txt2 = JSON.stringify(r2.data, null, 2);
        if (externalName) await fs.writeFile(path.join(EXTERNAL, externalName), txt2, 'utf-8');
        if (nationalPath) await fs.writeFile(nationalPath, txt2, 'utf-8');
        return { ok: true };
      }
    } catch (e2) {
      console.warn('http fallback failed', url, e2.message);
    }
    return { ok: false };
  }
}

async function parallelFetch(tasks, concurrency = 10, delayMs = 80, maxRetries = 3) {
  let idx = 0; let fetched = 0;
  const failed = [];

  const jitterMs = Math.max(20, Math.floor(delayMs * 0.5));

  async function worker(id) {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) break;
      const t = tasks[i];
      let attempt = 0;
      let success = false;
      let lastRetryAfter = null;
      while (attempt <= maxRetries && !success) {
        attempt++;
        const res = await fetchAndWrite(t.url, t.external, t.national);
        if (res.ok) { success = true; fetched++; break; }
        if (res.retryAfter) {
          lastRetryAfter = res.retryAfter;
          const waitMs = Math.max(1000, Math.round(res.retryAfter * 1000));
          const jitter = Math.floor(Math.random() * 1000);
          console.log(`Worker ${id}: 429 => sleeping ${waitMs + jitter}ms before retrying ${t.url}`);
          await sleep(waitMs + jitter);
          continue;
        }
        // exponential backoff with jitter
        const backoff = Math.min(1000 * Math.pow(2, attempt), 30000);
        const jitter = Math.floor(Math.random() * jitterMs);
        await sleep(backoff + jitter);
      }
      if (!success) {
        failed.push(t);
        if (lastRetryAfter) {
          console.warn(`Worker ${id}: Giving up on ${t.url} after ${attempt - 1} tries (last Retry-After ${lastRetryAfter}s)`);
        }
      }
      // polite pause between requests (add jitter)
      const extra = Math.floor(Math.random() * jitterMs);
      await sleep(delayMs + extra);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, (_, i) => worker(i + 1));
  await Promise.all(workers);

  if (failed.length) console.warn('Some tasks still failed after retries:', failed.length);
  return fetched;
}

async function validateLocalData() {
  const report = { total: 0, parsed: 0, errors: [] };
  const folders = [EXTERNAL, FINRA, SEC];
  for (const folder of folders) {
    try {
      const files = await fs.readdir(folder);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const p = path.join(folder, f);
        report.total++;
        try {
          const txt = await fs.readFile(p, 'utf-8');
          if (!txt || !txt.trim()) throw new Error('empty file');
          JSON.parse(txt);
          report.parsed++;
        } catch (e) {
          report.errors.push({ file: p, error: String(e.message || e) });
        }
      }
    } catch (e) {
      // ignore missing folders
    }
  }
  // write report
  try { await fs.writeFile(path.join(ROOT, 'data', 'last_crawl_report.json'), JSON.stringify(report, null, 2), 'utf-8'); } catch {}
  return report;
}

async function main() {
  await ensureDirs();
  const argv = require('minimist')(process.argv.slice(2));
  const concurrency = Number(argv.concurrency || argv.c || 20);
  const force = argv.force || argv.f || false;
  const limit = Number(argv.limit || 2000);

  const { firms, inds } = await gatherSeedIds();
  // augment with seed-profiles individuals as extra
  try {
    const seedFile = path.join(ROOT, 'data', 'seed-profiles.json');
    const seeds = JSON.parse(await fs.readFile(seedFile, 'utf-8'));
    if (Array.isArray(seeds.profiles)) {
      const prof = seeds.profiles.find(p => p.name === 'custom');
      if (prof && Array.isArray(prof.individuals)) {
        for (const id of prof.individuals) inds.add(String(id));
      }
    }
  } catch {}

  const tasks = [];
  for (const id of inds) {
    if (tasks.length >= limit) break;
    const numeric = /^\d+$/.test(id);
    if (numeric) {
      const finraPath = path.join(FINRA, `individual_${id}.json`);
      const secPath = path.join(SEC, `sec_${id}.json`);
      if (force || !await exists(finraPath)) tasks.push({ url: finraIndividualUrl(id), external: `finra_individual_${id}.json`, national: finraPath });
      if (force || !await exists(secPath)) tasks.push({ url: secIndividualUrl(id), external: `sec_individual_${id}.json`, national: secPath });
    }
  }
  for (const id of firms) {
    if (tasks.length >= limit) break;
    const numeric = /^\d+$/.test(id);
    const finraPath = path.join(FINRA, numeric ? `query_firm_${id}.json` : `query_firm_${id}.json`);
    const secPath = path.join(SEC, `sec_${id}.json`);
    if (force || !await exists(finraPath)) tasks.push({ url: finraFirmUrl(id), external: `finra_firm_${id}.json`, national: finraPath });
    if (force || !await exists(secPath)) tasks.push({ url: secFirmUrl(id), external: `sec_firm_${id}.json`, national: secPath });
  }

  console.log('Prepared', tasks.length, 'tasks; running with concurrency=', concurrency);
  const delay = Number(argv.delay || argv.d || 80);
  const fetched = await parallelFetch(tasks, concurrency, delay);
  console.log('Parallel crawl complete. fetched=', fetched);
  console.log('Validating local JSON files...');
  const report = await validateLocalData();
  console.log('Validation summary:', report.total, 'files, parsed=', report.parsed, 'errors=', report.errors.length);
  if (report.errors.length) console.log('Sample error:', report.errors[0]);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
