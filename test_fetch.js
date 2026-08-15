const { GET } = require('./.next/server/app/api/finra/merged/individual/[crd]/route.js');
const { NextRequest } = require('next/server');
async function run() {
    const req = new NextRequest('http://localhost:4444/api/finra/merged/individual/4317416?merged=1');
    const res = await GET(req, { params: Promise.resolve({ crd: '4317416' }) });
    const json = await res.json();
    console.log(json);
}
run();
