const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const DAY = 86400000;

function httpError(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }
function parsePeriod(from, to) {
  for (const date of [from, to]) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw httpError(400, 'Укажите существующие даты в формате ГГГГ-ММ-ДД.');
    }
  }
  const start = Date.parse(`${from}T00:00:00+03:00`);
  const end = Date.parse(`${to}T00:00:00+03:00`) + DAY;
  if (start >= end) throw httpError(400, 'Дата начала должна быть не позже даты окончания.');
  return { from, to, start, end, timezone: 'Europe/Moscow' };
}

function createBulkTagging(deps) {
  const { request, normalizeTask, normalizeTasks, getGroupId, getGroupName, isCollab, excludedGroupIds, classify, updateTags, deadline, enabled } = deps;
  const jobs = new Map();
  const terminal = job => !['selecting', 'ready', 'running'].includes(job.status);
  const busy = () => [...jobs.values()].find(job => ['selecting', 'running'].includes(job.status));
  const taskId = task => String(task.id ?? task.ID ?? '');
  const title = task => task.title || task.TITLE || '';
  const closedDate = task => task.closedDate || task.CLOSED_DATE;
  const ttl = 24 * 60 * 60 * 1000;

  async function eligibility(task, period, groupCache) {
    if (String(task.status ?? task.STATUS ?? task.realStatus ?? task.REAL_STATUS) !== '5') return 'not_closed';
    const closed = Date.parse(closedDate(task));
    if (!Number.isFinite(closed) || closed < period.start || closed >= period.end) return 'outside_period';
    const groupId = getGroupId(task);
    if (groupId == null || !/^\d+$/.test(String(groupId))) return 'group_unknown';
    if (excludedGroupIds.has(String(groupId))) return 'excluded_group';
    if (isCollab(getGroupName(task))) return 'collab_group';
    // Personal tasks (group 0) were allowed by the original tagging scenario.
    if (String(groupId) === '0') return null;
    let info = groupCache?.get(String(groupId));
    if (!info) {
      // Do not use the legacy persistent group cache before writes: names can change.
      try {
        const response = await request('GET', `/workgroups/${encodeURIComponent(groupId)}`);
        const data = response?.data || response?.result || response;
        const group = data?.workgroup || data?.group || data;
        const name = group?.name || group?.NAME || group?.title || group?.TITLE;
        info = { reason: !name ? 'group_unknown' : isCollab(name) ? 'collab_group' : null };
      } catch (error) {
        // A historical task can outlive its group. Skip it without aborting the
        // entire selection, but do not hide timeouts, rate limits or auth failures.
        if (error.statusCode !== 404) throw error;
        info = { reason: 'group_not_found' };
      }
      if (groupCache) groupCache.set(String(groupId), info);
    }
    return info.reason;
  }

  function publicJob(job, offset = 0) {
    return { ok: true, job_id: job.id, status: job.status, period: job.period,
      found: job.found, selected: job.tasks.length, excluded: job.excluded,
      checked: job.results.length, updated: job.updated, skipped: job.skipped, failed: job.failed,
      current_task_id: job.currentTaskId, error: job.error, cancel_requested: job.cancelRequested,
      created_at: job.createdAt, finished_at: job.finishedAt,
      excluded_groups: [...excludedGroupIds],
      tasks: job.tasks.slice(offset, offset + 100), results: job.results.slice(offset, offset + 100),
      offset, page_size: 100, excluded_reasons: job.excludedReasons };
  }

  async function selectTasks(job) {
    const seen = new Set();
    const groups = new Map();
    try {
      for (let offset = 0; ; ) {
        if (job.cancelRequested) { job.status = 'cancelled'; break; }
        const response = await request('POST', '/tasks/search', {
          filter: { realStatus: 5, closedDate: { $gte: new Date(job.period.start).toISOString(), $lt: new Date(job.period.end).toISOString() }, groupId: { $nin: [...excludedGroupIds].map(Number) } },
          select: ['id', 'title', 'status', 'groupId', 'closedDate'],
          order: { id: 'asc' }, autoWindow: false, limit: 50, offset, withTotal: false,
        });
        if (response?.success === false || response?.meta?.pageErrorSample) throw Error('API вернул неполную выборку. Запустите отбор повторно.');
        const page = normalizeTasks(response);
        if (!Array.isArray(response?.data) && !Array.isArray(response) && !Array.isArray(response?.data?.tasks) && !Array.isArray(response?.tasks) && !Array.isArray(response?.result?.tasks)) throw Error('Неизвестный формат списка задач.');
        let added = 0;
        for (const task of page) {
          if (job.cancelRequested) break;
          const id = taskId(task);
          if (!/^[1-9]\d*$/.test(id)) throw Error('API вернул задачу без корректного ID.');
          if (seen.has(id)) continue;
          seen.add(id); added++; job.found++;
          if (seen.size > 50000) throw Error('В периоде более 50 000 задач. Сузьте период; запись ещё не запускалась.');
          const reason = await eligibility(task, job.period, groups);
          if (reason) { job.excluded++; job.excludedReasons[reason] = (job.excludedReasons[reason] || 0) + 1; }
          else job.tasks.push({ id, title: title(task), closed_date: closedDate(task), group_id: String(getGroupId(task)) });
        }
        const more = response?.meta?.hasMore ?? (page.length === 50);
        if (!more) break;
        if (!page.length || !added) throw Error('Пагинация API не продвигается. Отбор остановлен без записи тегов.');
        offset += page.length;
      }
      job.status = job.cancelRequested ? 'cancelled' : 'ready';
    } catch (error) { job.status = 'failed'; job.error = error.message; }
    if (terminal(job)) job.finishedAt = Date.now();
  }

  function createSelection(from, to) {
    const period = parsePeriod(from, to);
    if (!enabled()) throw httpError(409, 'Установка тегов отключена (TASK_TAGGING_ENABLED=false).');
    if (busy()) throw httpError(409, 'Уже выполняется отбор или обработка. Дождитесь завершения.');
    for (const [id, job] of jobs) if (Date.now() - (job.finishedAt || job.createdAt) > ttl && !['selecting', 'running'].includes(job.status)) jobs.delete(id);
    if (jobs.size >= 10) throw httpError(409, 'Сохранено 10 запусков. Удалите завершённый отбор перед новым.');
    const job = { id: randomUUID(), period, status: 'selecting', tasks: [], results: [], found: 0, excluded: 0, excludedReasons: {}, updated: 0, skipped: 0, failed: 0, cancelRequested: false, createdAt: Date.now() };
    jobs.set(job.id, job);
    setImmediate(() => selectTasks(job));
    return job;
  }

  async function processTask(id, period) {
    if (!enabled()) return { skipped: true, reason: 'tagging_disabled' };
    const initial = normalizeTask(await request('GET', `/tasks/${id}`));
    let reason = await eligibility(initial, period);
    if (reason) return { skipped: true, reason };
    const analysis = await classify(id, task => eligibility(task, period));
    if (analysis.skipped) return analysis;
    // Historical tasks need no SUMMARY. Re-read to preserve current manual tags and
    // recheck the actual status, close date and group immediately before PATCH.
    const current = normalizeTask(await request('GET', `/tasks/${id}`));
    reason = await eligibility(current, period);
    if (reason) return { skipped: true, reason };
    return { ...await updateTags(id, analysis.tagClassification, current), mediaWarnings: analysis.mediaWarnings };
  }

  async function runJob(job) {
    try {
      for (const task of job.tasks) {
        if (job.cancelRequested) break;
        job.currentTaskId = task.id;
        let result;
        try { result = await deadline(() => processTask(task.id, job.period)); }
        catch (error) { result = { error: error.message }; }
        const outcome = result.error ? 'failed' : result.updated ? 'updated' : 'skipped';
        job[outcome]++;
        job.results.push({ task_id: task.id, title: task.title, outcome, ...result });
      }
      job.status = job.cancelRequested ? 'cancelled' : 'completed';
    } catch (error) { job.status = 'failed'; job.error = error.message; }
    finally { job.currentTaskId = null; job.finishedAt = Date.now(); }
  }

  function start(job) {
    if (job.status === 'running' || job.status === 'completed') return job;
    if (job.status !== 'ready') throw httpError(409, 'Дождитесь успешного завершения отбора.');
    if (busy()) throw httpError(409, 'Другой запуск уже выполняется.');
    if (!enabled()) throw httpError(409, 'Установка тегов отключена.');
    job.status = 'running';
    setImmediate(() => runJob(job));
    return job;
  }

  async function jsonBody(req) {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) throw httpError(413, 'Слишком большой запрос.'); }
    try { return JSON.parse(body); } catch { throw httpError(400, 'Ожидается JSON.'); }
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ai-test' && !url.pathname.startsWith('/tagging/')) return false;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === '/ai-test' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(__dirname, 'bulk-tagging.html'), 'utf8'));
        return true;
      }
      if (url.pathname === '/tagging/select' && req.method === 'POST') {
        const body = await jsonBody(req); send(202, publicJob(createSelection(body.from, body.to))); return true;
      }
      const job = jobs.get(url.searchParams.get('jobId'));
      if (!job) throw httpError(404, 'Запуск не найден. После перезапуска сервера выполните отбор заново.');
      if (url.pathname === '/tagging/status' && req.method === 'GET') {
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isInteger(offset) || offset < 0) throw httpError(400, 'Неверное смещение.');
        send(200, publicJob(job, offset));
      } else if (url.pathname === '/tagging/start' && req.method === 'POST') send(202, publicJob(start(job)));
      else if (url.pathname === '/tagging/cancel' && req.method === 'POST') {
        job.cancelRequested = true;
        if (job.status === 'ready') { job.status = 'cancelled'; job.finishedAt = Date.now(); }
        send(200, publicJob(job));
      } else if (url.pathname === '/tagging/job' && req.method === 'DELETE') {
        if (['selecting', 'running'].includes(job.status)) throw httpError(409, 'Сначала остановите запуск.');
        jobs.delete(job.id); send(200, { ok: true });
      } else send(404, { ok: false, error: 'Маршрут не найден.' });
    } catch (error) { send(error.statusCode || 500, { ok: false, error: error.message }); }
    return true;
  }
  return { handle, eligibility, createSelection, processTask, start, publicJob, jobs };
}
module.exports = { createBulkTagging, parsePeriod };
