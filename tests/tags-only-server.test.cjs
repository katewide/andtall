const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function boot() {
  const state = { timers: [], requests: [], handler: null };
  class Database { serialize(fn) { fn(); } run() {} }
  const context = vm.createContext({
    require(name) {
      if (name === './bulk-tagging.cjs') return require('../bulk-tagging.cjs');
      if (name === 'http') return { createServer(fn) { state.handler = fn; return { listen(port, ready) { ready(); } }; } };
      if (name === 'https') return { request() { throw Error('Unexpected network request'); } };
      if (name === 'sqlite3') return { verbose: () => ({ Database }) };
      if (name === 'fs') return { ...fs, mkdirSync() {} };
      return require(name);
    },
    __dirname: path.join(__dirname, '..'),
    process: { env: { BASE_URL: 'https://example.invalid', API_KEY: 'test', WEBHOOK_TOKEN: 'test', TASK_TIME_CHECK_ENABLED: 'true', TASK_TIME_CHECK_RUN_ON_START: 'true', OPEN_TASK_CHECK_ENABLED: 'true', OPEN_TASK_CHECK_RUN_ON_START: 'true' } },
    console: { log() {}, error() {} }, URL, AbortController, Buffer,
    setTimeout(fn) { state.timers.push(fn); return { unref() {} }; }, clearTimeout() {},
    setInterval() { throw Error('Unexpected interval'); },
  });
  vm.runInContext(source, context);
  return state;
}
test('startup schedules no monitoring even when legacy flags are enabled', () => {
  assert.equal(boot().timers.length, 0);
});
test('disabled manual routes return 404 for GET, HEAD and POST without work', async () => {
  const state = boot();
  for (const route of ['/ai-preview', '/ai-preview/status', '/open-tasks-check', '/open-task-eligibility', '/time-check', '/time-entry-baseline']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      let status;
      const req = { method, url: route, headers: {}, on(event, fn) { if (event === 'end') fn(); return this; } };
      const res = { writeHead(code) { status = code; }, end() {}, setHeader() {} };
      await state.handler(req, res);
      assert.equal(status, 404, `${method} ${route}`);
    }
  }
  assert.equal(state.timers.length, 0);
});
test('health endpoint stays available', async () => {
  const state = boot(); let status, body;
  await state.handler({ method: 'GET', url: '/', headers: {} }, { writeHead(code) { status = code; }, end(value) { body = value; } });
  assert.equal(status, 200); assert.equal(body, 'OK');
});

test('ai-test serves the bulk close-date form without starting work', async () => {
 const state = boot(); let status, body;
 await state.handler({method:'GET',url:'/ai-test',headers:{}},{writeHead(code){status=code;},end(value){body=value;}});
 assert.equal(status,200);assert.match(body,/type="date"/);assert.match(body,/Хэштеги за период/);assert.equal(state.timers.length,0);
});
