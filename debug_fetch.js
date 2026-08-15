const http = require('http');

http.get('http://localhost:3000/api/finra/merged/individual/4317416', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
}).on('error', (e) => console.error(e));
