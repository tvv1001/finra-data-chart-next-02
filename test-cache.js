const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 8079,
  path: '/',
  method: 'GET'
});
req.on('error', () => {});
req.end();
