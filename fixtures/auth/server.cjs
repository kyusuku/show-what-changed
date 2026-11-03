require('node:http').createServer((request, response) => {
  const authenticated = request.headers.cookie === `session=${process.env.SWC_SIDE}-cookie`;
  response.setHeader('content-type', 'text/html');
  response.end(`<body data-cookie="${authenticated}"><script>document.body.textContent = document.body.dataset.cookie + ':' + localStorage.getItem('local-auth')</script></body>`);
}).listen(Number(process.argv[2]), '127.0.0.1');
