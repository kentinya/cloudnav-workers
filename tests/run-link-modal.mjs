import { createServer } from 'vite';

const server = await createServer({ server: { host: '127.0.0.1', port: 3001, strictPort: true, open: false } });
let finish;
const completed = new Promise(resolve => { finish = resolve; });
server.ws.on('link-modal-results', data => {
  console.log(data.results.join('\n'));
  process.exitCode = data.status === 'passed' ? 0 : 1;
  finish();
});
await server.listen();
console.log('Open http://127.0.0.1:3001/tests/link-modal.html in a browser.');
await completed;
await server.close();
