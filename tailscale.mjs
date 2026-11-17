import http from 'node:http';
import {isIPv4} from 'node:net';

// node tailscale.mjs <Mac Tailscale IPv4> <phone Tailscale IPv4>
const [mac, phone] = process.argv.slice(2);
const port = Number(process.env.PORT || 8791);
const tailAddress = ip => isIPv4(ip || '') && /^100\./.test(ip) &&
  Number(ip.split('.')[1]) >= 64 && Number(ip.split('.')[1]) <= 127;
if (![mac, phone].every(tailAddress)) throw Error('Укажите Tailscale IPv4 для Mac и телефона.');
const authority = mac + ':' + port;
const upstream = '127.0.0.1:' + port;

const server = http.createServer((req, res) => {
  if (![mac, phone].includes(req.socket.remoteAddress) || req.headers.host !== authority ||
      (req.headers.origin && req.headers.origin !== 'http://' + authority)) {
    res.writeHead(403).end();
    return;
  }
  const headers = {host: upstream};
  for (const name of ['content-type', 'content-length', 'x-studio', 'accept']) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  if (req.headers.origin) headers.origin = 'http://' + upstream;
  const target = http.request({hostname: '127.0.0.1', port, method: req.method, path: req.url, headers}, reply => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.on('error', () => res.destroy());
    reply.pipe(res);
  });
  target.on('error', () => {
    if (res.headersSent) res.destroy();
    else res.writeHead(502).end('Локальная студия недоступна');
  });
  res.on('close', () => target.destroy());
  req.on('error', () => target.destroy());
  req.pipe(target);
});
server.listen(port, mac, () => console.log('VideoRouter · http://' + authority));
