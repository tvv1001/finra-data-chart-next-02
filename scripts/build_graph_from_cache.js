#!/usr/bin/env node
const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');

const ROOT = process.cwd();
const BASE = path.join(ROOT, 'data', 'national');
const FINRA = path.join(BASE, 'brokercheck.finra.org');
const SEC = path.join(BASE, 'adviserinfo.sec.gov');

function personId(crd) { return `person:${crd}`; }
function firmId(id) { return `firm:${id}`; }

async function readJsonFiles(dir) {
  const out = [];
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf-8');
        out.push({ file: f, json: JSON.parse(raw) });
      } catch {}
    }
  } catch {}
  return out;
}

function extractPeopleAndFirmsFromHits(json) {
  const nodes = { people: new Map(), firms: new Map(), links: [] };
  const hits = json?.hits?.hits || [];
  for (const h of hits) {
    const src = h._source || {};
    const crd = src.ind_source_id || src.person?.crd || (src.content && (() => { try { const p = typeof src.content === 'string' ? JSON.parse(src.content) : src.content; return p?.basicInformation?.crd || p?.basicInformation?.individualId; } catch {return null;} })());
    if (crd) {
      nodes.people.set(String(crd), { id: personId(crd), label: `${src.ind_firstname||''} ${src.ind_lastname||''}`.trim() || String(crd), group: 'individual' });
      const emps = src.ind_current_employments || src.ind_previous_employments || [];
      for (const e of emps) {
        const fid = e.firmId || e.firm_id || e.firmId;
        if (fid) {
          nodes.firms.set(String(fid), { id: firmId(fid), label: e.firmName || String(fid), group: 'firm' });
          nodes.links.push({ source: personId(crd), target: firmId(fid), type: 'employed_by' });
        }
      }
    }
    // firms in source
    if (src.firm_id || src.firm_bd_sec_number || src.firm_bd_full_sec_number) {
      const fid = src.firm_id || src.firm_bd_sec_number || src.firm_bd_full_sec_number;
      nodes.firms.set(String(fid), { id: firmId(fid), label: src.firm_name || src.firmName || String(fid), group: 'firm' });
    }
  }
  return nodes;
}

async function build() {
  const finraFiles = await readJsonFiles(FINRA);
  const secFiles = await readJsonFiles(SEC);
  const people = new Map();
  const firms = new Map();
  const links = [];
  const parsedFiles = [...finraFiles, ...secFiles];

  // First pass: collect people and firms
  for (const f of parsedFiles) {
    const { people: p, firms: fo, links: li } = extractPeopleAndFirmsFromHits(f.json || f);
    for (const [k, v] of p) people.set(k, v);
    for (const [k, v] of fo) firms.set(k, v);
    for (const l of li) links.push(l);
  }

  const firmIdSet = new Set(Array.from(firms.keys()));

  // Helper: recursively search an object for firm ids
  function findFirmIds(obj, out = new Set()) {
    if (!obj) return out;
    if (typeof obj === 'string' || typeof obj === 'number') {
      const s = String(obj).trim();
      if (firmIdSet.has(s)) out.add(s);
      return out;
    }
    if (Array.isArray(obj)) {
      for (const v of obj) findFirmIds(v, out);
      return out;
    }
    if (typeof obj === 'object') {
      for (const v of Object.values(obj)) findFirmIds(v, out);
      return out;
    }
    return out;
  }

  // Heuristic: find firm names in object fields
  function findFirmNames(obj, out = new Set()) {
    if (!obj) return out;
    if (typeof obj === 'string') {
      const s = obj.trim();
      if (s.length > 2 && /firm|broker|bd|broker-dealer|company/i.test(s) && s.length < 120) out.add(s);
      return out;
    }
    if (typeof obj === 'number') return out;
    if (Array.isArray(obj)) {
      for (const v of obj) findFirmNames(v, out);
      return out;
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (/firm|firmName|firm_name|broker/i.test(k)) findFirmNames(v, out);
        else findFirmNames(v, out);
      }
      return out;
    }
    return out;
  }

  // Second pass: for each parsed file, if it corresponds to a person, look for firm ids in its content
  for (const f of parsedFiles) {
    const obj = f.json || f;
    // try to find a crd for person
    let crd = null;
    try {
      // Try to extract CRD from the hits
      const hits = obj?.hits?.hits || [];
      for (const hit of hits) {
        const src = hit._source || {};
        if (src.ind_source_id) crd = String(src.ind_source_id);
        else if (src.person && src.person.crd) crd = String(src.person.crd);
        else if (src.content) {
          const c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
          crd = c?.basicInformation?.crd || c?.basicInformation?.individualId;
          if (crd) crd = String(crd);
        }
        if (crd) break; // Found one, stop looking
      }
    } catch (e) {
      crd = null;
    }
    if (crd && people.has(crd)) {
      const found = findFirmIds(obj);
      for (const fid of found) {
        links.push({ source: personId(crd), target: firmId(fid), type: 'employed_by' });
        firms.set(fid, firms.get(fid) || { id: firmId(fid), label: String(fid), group: 'firm' });
      }
      // Heuristic firm names
      const names = findFirmNames(obj);
      for (const nm of names) {
        const slug = nm.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        const fid = `name:${slug}`;
        links.push({ source: personId(crd), target: firmId(fid), type: 'employed_by' });
        firms.set(fid, firms.get(fid) || { id: firmId(fid), label: nm, group: 'firm' });
      }
      // also try parsing content JSON more deeply for employment arrays
      try {
        const hits = obj?.hits?.hits || [];
        for (const hit of hits) {
          const src = hit._source || {};
          let c = null;
          if (src.content) {
            c = typeof src.content === 'string' ? JSON.parse(src.content) : src.content;
          }
          if (c) {
            const currentEmps = c?.currentEmployments || c?.ind_current_employments || [];
            const prevEmps = c?.previousEmployments || c?.ind_previous_employments || [];
            const allEmps = [...currentEmps, ...prevEmps];
            for (const e of allEmps) {
              const fid = e.firmId || e.firm_id || e.firmId;
              if (fid) {
                links.push({ source: personId(crd), target: firmId(String(fid)), type: 'employed_by' });
                firms.set(String(fid), firms.get(String(fid)) || { id: firmId(String(fid)), label: e.firmName || String(fid), group: 'firm' });
              }
            }
          }
        }
      } catch (e) {}
    }
  }

  // Inspect firm files for directOwners → create 'controls' links
  for (const f of parsedFiles) {
    const obj = f.json || f;
    let targetFirm = null;
    try {
      targetFirm = obj.firm_id || obj.firmId || obj.firm_bd_sec_number || obj.bdSECNumber || (obj.content && (() => { try { const c = typeof obj.content === 'string' ? JSON.parse(obj.content) : obj.content; return c?.basicInformation?.firmId || c?.basicInformation?.bdSECNumber; } catch { return null; } })());
      if (targetFirm) targetFirm = String(targetFirm);
    } catch (e) { targetFirm = null; }
    if (!targetFirm) continue;
    try {
      const owners = obj.directOwners || [];
      if (Array.isArray(owners) && owners.length) {
        for (const o of owners) {
          // owner may be a firm or a person/entity
          if (o.ownerFirmId) {
            const ofid = String(o.ownerFirmId);
            firms.set(ofid, firms.get(ofid) || { id: firmId(ofid), label: String(ofid), group: 'firm' });
            links.push({ source: firmId(ofid), target: firmId(targetFirm), type: 'controls' });
          } else if (o.ownerId || o.ownerPersonId) {
            const pid = String(o.ownerId || o.ownerPersonId);
            people.set(pid, people.get(pid) || { id: personId(pid), label: String(pid), group: 'individual' });
            links.push({ source: personId(pid), target: firmId(targetFirm), type: 'controls' });
          } else if (o.ownerName) {
            const slug = String(o.ownerName).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            const eid = `entity:${slug}`;
            firms.set(eid, firms.get(eid) || { id: firmId(eid), label: o.ownerName, group: 'entity' });
            links.push({ source: firmId(eid), target: firmId(targetFirm), type: 'controls' });
          }
        }
      }
    } catch (e) {}
  }
  // Fallback: if no links discovered, attach first person to a synthetic firm so graph isn't empty
  if (links.length === 0 && people.size > 0) {
    const firstPerson = people.keys().next().value;
    const fid = 'name:unknown_employer';
    firms.set(fid, firms.get(fid) || { id: firmId(fid), label: 'Unknown Employer', group: 'firm' });
    links.push({ source: personId(firstPerson), target: firmId(fid), type: 'employed_by' });
  }

  const nodes = [...people.values(), ...firms.values()];
  console.log('Built nodes=', nodes.length, 'links=', links.length);

  try {
    const res = await axios.post('http://localhost:3000/api/finra/graph-append', { nodes, links }, { timeout: 60000 });
    console.log('graph-append response:', res.data);
  } catch (err) {
    console.error('Failed to append graph:', err.message);
  }
}

if (require.main === module) build().catch((e)=>{ console.error(e); process.exit(1); });
