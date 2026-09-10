import { createServer } from 'node:http';
createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end('{"service":"hybrid-substation-window","status":"running"}'); }).listen(Number(process.env.PORT || 8080));
