const fs = require('fs');
const https = require('https');

https.get('https://api.brokercheck.finra.org/search/firm/160481', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const payload = JSON.parse(data);
        function unwrapRecordPayload(input) {
            let parsed = input;
            if (typeof input === 'string') {
                try { parsed = JSON.parse(input); } catch (e) {}
            }
            if (parsed == null || typeof parsed !== 'object') return parsed;
            if (Array.isArray(parsed)) return parsed;

            if (parsed.finraBrokerCheck && typeof parsed.finraBrokerCheck === 'object') {
                return unwrapRecordPayload(parsed.finraBrokerCheck);
            }
            if (parsed.secInvestmentAdvisor && typeof parsed.secInvestmentAdvisor === 'object') {
                return unwrapRecordPayload(parsed.secInvestmentAdvisor);
            }

            if (parsed.content != null) return unwrapRecordPayload(parsed.content);
            if (parsed.iacontent != null) return unwrapRecordPayload(parsed.iacontent);

            const firstHit = Array.isArray(parsed.hits?.hits) ? parsed.hits.hits[0] : null;
            if (firstHit && typeof firstHit === 'object') {
                const source = firstHit._source;
                if (source && typeof source === 'object') {
                    if (source.content != null) return unwrapRecordPayload(source.content);
                    if (source.iacontent != null) return unwrapRecordPayload(source.iacontent);
                    return source;
                }
            }

            return parsed;
        }

        const body = unwrapRecordPayload(payload);
        console.log("Keys in body:", Object.keys(body));
        console.log("Disclosures:", body.disclosures);
    });
});
