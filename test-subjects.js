const http = require('http');
http.get('http://127.0.0.1:3000/api/subjects', (resp) => {
  let data = '';
  resp.on('data', (chunk) => { data += chunk; });
  resp.on('end', () => { console.log("Status:", resp.statusCode, "Data:", data); });
}).on("error", (err) => { console.log("Error: " + err.message); });
