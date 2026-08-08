import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { getGraph } from '../src/lib/graphStore';
import { shouldSuppressSecLink } from '../src/lib/finra-graph/linkSuppression';

async function run() {
    try {
        const graph = await getGraph();
        console.log(`Loaded graph with ${graph.nodes?.length || 0} nodes.`);
        
        const firms = (graph.nodes || []).filter((n: any) => n.group === 'firm');
        console.log(`Found ${firms.length} firms.`);
        
        let suppressedCount = 0;
        let likelyBroken = 0;

        for (const firm of firms) {
            const isSuppressed = shouldSuppressSecLink(firm, 'firm');
            if (isSuppressed) suppressedCount++;
            
            // Re-implement the SEC link check logic here
            const hasSecData = firm.hasSecData === true;
            const hasEmbeddedDetail = firm.hasEmbeddedDetail === true;
            
            let hasPresence = false;
            if (hasSecData) hasPresence = true;
            else if (hasEmbeddedDetail && !hasSecData) hasPresence = false;
            else if (Boolean(String(firm.iaScope || firm.basicInformation?.iaScope || '').trim())) hasPresence = true;
            else if (Boolean(String(firm.iaSecNumber || firm.basicInformation?.iaSecNumber || firm.secNumber || '').trim())) hasPresence = true;
            else if (Boolean(String(firm.secSummaryDescription || firm.basicInformation?.secSummaryDescription || '').trim())) hasPresence = true;
            // skipping deeper checks for simplicity if already true
            
            if (hasPresence && !isSuppressed) {
                // Check if they are terminated > 10 years ago
                const terminationDate = firm.basicInformation?.terminationDate || firm.terminationDate;
                if (terminationDate) {
                    const yearMatch = String(terminationDate).match(/\d{4}/);
                    if (yearMatch) {
                        const year = parseInt(yearMatch[0], 10);
                        if (year <= 2016) {
                            console.log(`Potential broken SEC link: Firm ${firm.id} (CRD ${firm.firmId || firm.basicInformation?.firmId}) terminated in ${year}`);
                            likelyBroken++;
                        }
                    }
                }
            }
        }
        
        console.log(`\nCurrently suppressed: ${suppressedCount}`);
        console.log(`Likely broken (terminated <= 2016 with sec presence): ${likelyBroken}`);
    } catch (e) {
        console.error(e);
    }
}

run();
