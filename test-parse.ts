import { normalizeIndividualDetailFromSource } from './src/lib/individualDetail';
import { resolveIndividualSourceDetail } from './src/lib/sourceTruth';
import fs from 'fs';

const secRaw = fs.readFileSync('sec-response.json', 'utf8');
const secData = JSON.parse(secRaw);

console.log("Hits:", secData.hits.hits.length);
const source = secData.hits.hits[0]._source;
console.log("Source keys:", Object.keys(source));

const detail = resolveIndividualSourceDetail(source);
console.log("Detail is null?", detail.detail === null);

if (detail.detail === null) {
  // Let's debug getEmbeddedContentObject
  const keys = ['content', 'iacontent'];
  for (const key of keys) {
      const raw = source[key];
      if (raw) {
          console.log(`Key ${key} exists`);
          try {
              const parsed = JSON.parse(raw);
              console.log("Parsed keys:", Object.keys(parsed));
          } catch(e) {
              console.log("Parse failed", e);
          }
      }
  }
}
import { hasIndividualSourceCoverage } from './src/lib/sourceTruth';
const det = detail.detail;
console.log("hasSecData:", hasIndividualSourceCoverage(det, 'sec'));
console.log("hasFinraData:", hasIndividualSourceCoverage(det, 'finra'));
