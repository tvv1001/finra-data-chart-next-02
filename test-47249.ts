import { loadCachedFirmPayload, hasPublicFinraFirmDetail } from './src/app/api/finra/firm/[id]/route';

async function run() {
  const finraBody = await loadCachedFirmPayload('finra', '47249');
  let bcDetail = null;
  if (finraBody && typeof finraBody === 'string') {
      try {
          const parsed = JSON.parse(finraBody);
          bcDetail = parsed.hits?.hits?.[0]?._source?.content ? JSON.parse(parsed.hits.hits[0]._source.content) : parsed;
      } catch (e) {
          console.error(e);
      }
  } else if (finraBody) {
      bcDetail = finraBody;
  }
  console.log("bcDetail:", bcDetail ? "exists" : "null");
  if (bcDetail) {
      console.log("bcScope:", bcDetail.basicInformation?.bcScope || bcDetail.bcScope);
      const hasFinra = hasPublicFinraFirmDetail(bcDetail, bcDetail.basicInformation || {});
      console.log("hasFinra:", hasFinra);
  }
}
run().catch(console.error);
