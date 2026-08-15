const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 8079,
  path: '/zrange/dashboard:highest-crds:individual/0/19/rev',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer test_token_xyz'
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
});
req.end();
