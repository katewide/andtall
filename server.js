const http = require('http');
const https = require('https');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

function getBitrixRestWebhookUrl() {
  const webhookUrl = process.env.BITRIX_REST_WEBHOOK_URL || process.env.WEBHOOK_COMMENT_URL;
  if (!webhookUrl) throw new Error('Missing required env BITRIX_REST_WEBHOOK_URL');

  return webhookUrl
    .replace(/task\.commentitem\.add(?:\.json)?$/i, '')
    .replace(/\/?$/, '/');
}

const PORT = process.env.PORT || 3000;
const BASE_URL = requireEnv('BASE_URL');
const API_KEY = requireEnv('API_KEY');
const MODEL_NAME = process.env.MODEL_NAME || 'bitrix/google/gemma-4-26B-A4B-it';

const BITRIX_REST_WEBHOOK_URL = getBitrixRestWebhookUrl();
const WEBHOOK_TOKEN = requireEnv('WEBHOOK_TOKEN');
const AUTHOR_ID = Number(requireEnv('AUTHOR_ID'));

function log(message, data) {
  console.log(`[${new Date().toISOString()}] ${message}`, data ? JSON.stringify(data) : '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseFormUrlEncoded(body) {
  const result = {};

  for (const [key, value] of new URLSearchParams(body)) {
    const parts = key.split(/[\[\]]/).filter(Boolean);
    let current = result;

    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current[part] = value;
        return;
      }

      current[part] ||= {};
      current = current[part];
    });
  }

  return result;
}

function appendParams(params, value, prefix) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendParams(params, item, `${prefix}[${index}]`));
    return;
  }

  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      appendParams(params, item, prefix ? `${prefix}[${key}]` : key);
    });
    return;
  }

  if (prefix) params.append(prefix, value == null ? '' : String(value));
}

function requestJson(endpoint, options = {}) {
  const client = endpoint.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(endpoint, options, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;

        try {
          json = data ? JSON.parse(data) : null;
        } catch {
          reject(new Error(`Invalid JSON from ${endpoint.pathname}: ${data}`));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from ${endpoint.pathname}: ${data}`));
          return;
        }

        if (json?.error) {
          reject(new Error(json.error_description || json.error));
          return;
        }

        if (json?.success === false) {
          reject(new Error(json.error?.message || json.error?.code || 'API returned success=false'));
          return;
        }

        resolve(json);
      });
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function bitrixCall(method, params = {}) {
  const endpoint = new URL(`${method}.json`, BITRIX_REST_WEBHOOK_URL);
  const body = new URLSearchParams();
  appendParams(body, params);

  return requestJson(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

function coworkRequest(method, path, body) {
  return requestJson(new URL(`/v1${path}`, BASE_URL), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function unwrapData(response) {
  return response?.data || response?.result || response || null;
}

function getTaskIdFromOutgoingWebhook(body) {
  return (
    body?.data?.FIELDS_AFTER?.ID ||
    body?.data?.FIELDS_BEFORE?.ID ||
    body?.data?.ID ||
    body?.data?.id ||
    body?.task_id ||
    body?.taskId ||
    null
  );
}

function getParentIdFromTask(task) {
  return task?.parentId ? String(task.parentId) : null;
}

function getResponsibleIdFromTask(task) {
  const responsibleId = (
    task?.responsibleId ||
    task?.responsibleID ||
    task?.ResponsibleID ||
    task?.responsible_id ||
    task?.RESPONSIBLE_ID ||
    task?.responsible?.id ||
    task?.assignee?.id
  );
  return responsibleId ? String(responsibleId).replace(/^user_/i, '') : null;
}

function getGroupIdFromTask(task) {
  const groupId = task?.groupId || task?.groupID || task?.GroupID || task?.group_id || task?.GROUP_ID || task?.group?.id;
  return groupId ? String(groupId) : null;
}

function getGroupNameFromTask(task) {
  return task?.groupName || task?.group?.name || task?.group?.title || null;
}

function isCollabGroupName(groupName) {
  return String(groupName || '').toLowerCase().includes('коллаба');
}

function normalizeId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeIds(value) {
  if (!value) return [];

  const raw = Array.isArray(value)
    ? value
    : typeof value === 'object'
      ? Object.values(value)
      : [value];

  return [...new Set(raw.map(normalizeId).filter(Boolean))];
}

function normalizeHistoryField(field) {
  return String(field || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function normalizeTaskPayload(response) {
  const data = unwrapData(response);
  return data?.task || data?.Task || data;
}

function normalizeCommentsPayload(response) {
  const data = unwrapData(response);
  const comments = data?.comments || data?.Comments || data?.items || data?.list || data;
  return Array.isArray(comments) ? comments : [];
}

function normalizeTimePayload(response) {
  const data = unwrapData(response);
  return Array.isArray(data) ? data : [];
}

async function addAccomplice(taskId, userId) {
  const taskResponse = await coworkRequest('GET', `/tasks/${taskId}`);
  const task = normalizeTaskPayload(taskResponse);
  const accomplices = normalizeIds(task?.accomplices || task?.accompliceIds || task?.ACCOMPLICES);
  const normalizedUserId = normalizeId(userId);

  if (!normalizedUserId) throw new Error(`Invalid accomplice user ID: ${userId}`);

  if (accomplices.includes(normalizedUserId)) {
    return { added: false, reason: 'already_accomplice', taskId, userId: normalizedUserId };
  }

  const nextAccomplices = [...accomplices, normalizedUserId];
  await coworkRequest('PATCH', `/tasks/${taskId}`, { accomplices: nextAccomplices });

  return { added: true, taskId, userId: normalizedUserId };
}

async function getLatestUpdateBatch(taskId) {
  const response = await bitrixCall('tasks.task.history.list', {
    taskId,
    order: { createdDate: 'DESC' },
  });

  const history = Array.isArray(response?.result?.list)
    ? response.result.list
    : Array.isArray(response?.result)
      ? response.result
      : [];

  const sortedHistory = history
    .map(item => ({ ...item, createdAtMs: Date.parse(item.createdDate) }))
    .filter(item => Number.isFinite(item.createdAtMs))
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  const latestChange = sortedHistory[0];
  if (!latestChange) return [];

  return sortedHistory.filter(item => latestChange.createdAtMs - item.createdAtMs <= 2000);
}

function findLatestFieldChange(updateBatch, fieldName) {
  const normalizedFieldName = normalizeHistoryField(fieldName);
  return updateBatch.find(item => normalizeHistoryField(item.field) === normalizedFieldName && item.value);
}

async function fetchTaskWithComments(taskId) {
  const [taskResult, commentsResult] = await Promise.allSettled([
    coworkRequest('GET', `/tasks/${taskId}`),
    coworkRequest('GET', `/tasks/${taskId}/comments`),
  ]);

  if (taskResult.status === 'rejected') {
    throw new Error(`Failed to fetch task ${taskId}: ${taskResult.reason.message}`);
  }

  const task = normalizeTaskPayload(taskResult.value);
  const comments = commentsResult.status === 'fulfilled'
    ? normalizeCommentsPayload(commentsResult.value)
    : [];

  return {
    task,
    comments,
  };
}

async function fetchTaskTimeLogs(taskId) {
  const response = await coworkRequest('GET', `/tasks/${taskId}/time`);
  return normalizeTimePayload(response);
}

function buildPrompt({ taskId, responsibleId, mainTask, mainComments, contextparentID }) {
  const context = {
    currentTaskId: taskId,
    responsibleId,
    currentTask: mainTask,
    currentTaskComments: mainComments,
  };

  return `Ты - профессиональный консультант 1С. Твоя задача - проанализировать данные задачи и написать краткий итог. Ты анализируешь задачи компании-франчайзи 1С. Используй профессиональную терминологию, принятую в сфере внедрения и сопровождения продуктов 1С.

НИЖЕ ПРИВЕДЕН КОНТЕКСТ ЗАДАЧИ (JSON):
${JSON.stringify(context, null, 2)}

НИЖЕ ПРИВЕДЕН КОНТЕКСТ РОДИТЕЛЬСКОЙ ЗАДАЧИ (JSON):
${JSON.stringify(contextparentID, null, 2)}

Правила анализа:
- Основной объект анализа - currentTask и currentTaskComments.
- Если контекст родительской задачи не равен null, используй parentTask и parentTaskComments только как дополнительный контекст.
- Если есть несоответствие данных задачи и комментариев, ориентируйся на комментарии.
- Используй только информацию, содержащуюся в JSON. Ничего не выдумывай и не добавляй от себя.
- Не добавляй технические детали, если они отсутствуют в исходных данных.
- Не называй конкретные механизмы 1С (планы обмена, регистры, EnterpriseData, СКД и т.п.), если они прямо не указаны или очевидно не следуют из контекста.

ЖЕСТКИЕ ПРАВИЛА нормализации отраслевой терминологии 1С <Таблица трансформации>:
Категорически запрещено переносить в результат разговорную речь, жалобы клиентов или бытовой сленг сотрудников, слова "срочно", "важно", "помощь". Обязательно переводи текстовые маркеры из левой части в строго профессиональные термины 1С из правой части:
1. Инфраструктура, базы данных и доработки:
- "программа", "1ска", "конфа" -> база / информационная база / типовая конфигурация / отраслевое решение.
- "накатить обнову", "обновить 1С", "поставить релиз" -> обновление конфигурации (типовой/доработанной) / обновление платформы 1С:Предприятие.
- "сделать доработку", "дописать код", "добавить кнопку", "запилить функцию" -> доработка конфигурации / разработка расширения конфигурации / добавление реквизита.
- "печатная форма не печатает", "сделать макет", "поправить ТОРГ-12/счет" -> модификация макета печатной формы / разработка внешней печатной формы.
- "написать отчет", "сделать выгрузку в Excel" -> разработка отчета / создание внешнего отчета.
- "обработка", "скрипт", "сделайте штуку чтобы заполнялось" -> разработка/применение внешней обработки.
2. Обмены, интеграции и регламентные процедуры
- "глюк/косяк/проблема с обменом", "не идет обмен", "двоятся данные" -> ошибка в механизме синхронизации данных / сбой плана обмена / рассинхронизация объектов метаданных.
- "обмен через ED", "новый обмен" -> обмен данными по стандарту EnterpriseData.
- "робот не отработал", "запустить регламентное", "автоматом не считается" -> сбой выполнения регламентного задания / настройка расписания регламентного задания.
- "загрузить выписку", "проблема с банком/клиент-банком" -> обмен с банком / загрузка выписок из банковских приложений.
- "настроить ЭДО", "не уходит подпись", "проблема с криптой/калугой/такскомом" -> настройка контура электронного документооборота / актуализация сертификата.
3. Учетные механизмы, документы и отчетность
- "посмотреть почему не проводится", "проверить документы" -> анализ причин невозможности проведения документа / проверка корректности заполнения аналитики.
- "перепровести за период", "полетела последовательность", "слетела последовательность" -> групповое перепроведение документов / восстановление последовательности проведения документов.
- "не закрывается месяц", "ошибка при закрытии", "не считается себестоимость/20 счет" -> регламентная операция закрытия периода / анализ распределения затрат / расчет себестоимости.
- "не идет отчет", "неправильно считает налог/НДФЛ/НДС", "неверное сальдо" -> некорректный расчет налога/НДФЛ/НДС / некорректное формирование движений по регистрам накопления (или регистрам сведений).
- "завести сотрудника", "уволить", "посчитать зп" -> кадровый учет / расчет и начисление заработной платы / формирование документов кадрового учета / расчет сотрудника.
4. Права доступа и администрирование
- "пользователь не может зайти", "права слетели", "дать доступ к складу" -> настройка прав доступа / назначение профилей групп доступа / ограничение прав/ролей пользователя.
- "программа зависла", "всех выбило", "ошибка СУБД" -> аварийное завершение сеанса / оптимизация работы сервера 1С:Предприятие.

ЗАДАНИЕ:
Сформируй результат строго в следующем формате.

[b]✅ SUMMARY:[/b]
В 1-2 предложениях кратко опиши суть задачи. Обязательно укажи:
- какая проблема или запрос были у клиента;
- каким способом проблема была решена или какие работы были выполнены.
- Не используй оценочные или шаблонные формулировки, такие как: "задача успешно решена", "работы успешно выполнены", "проблема полностью устранена", "вопрос закрыт" и аналогичные.
- Не используй слова "успешно", "полностью", "окончательно", "окончательно решена", если это прямо не указано в предоставленных данных.

[b]📝 TITLE:[/b]
- Предложи 2 наиболее подходящих варианта наименования задачи.
- Каждый вариант должен содержать от 3 до 15 слов.
- Название должно быть кратким, но максимально точно отражать выполненную работу.
- Если основная суть задачи - консультация или предоставление информации, начинай название со слов "Консультация по...".
- Если основная суть задачи - выполнение работ, настройка, исправление, разработка, подключение, обновление или иные действия, начинай название со слов "Проведение работ по...".
- Не используй общие или расплывчатые формулировки.
- Не добавляй никаких пояснений, вступлений, комментариев или рассуждений.

Проверка релиза (только для задач с наименованием, начинающимся на "Обновление баз..."):
- Если в исходном названии задачи и в комментариях упоминаются номера релизов (версий), сравни их.
- Если номера релизов отличаются, сразу после заголовка 📝 TITLE: выведи отдельной строкой:
❗️Релиз, указанный в задаче, не совпадает с фактическим.
- Если в названии задачи или комментариях номер релиза отсутствует либо определить его невозможно, предупреждение не выводи.

Проверка достаточности информации:
- Перед формированием результата оцени, достаточно ли информации для понимания проблемы и выполненных работ.
- Если из JSON невозможно определить, в чем заключалась проблема или какие действия были выполнены, не пытайся делать предположения и не придумывай содержание.
- В этом случае не выводи разделы ✅ SUMMARY и 📝 TITLE.
- Вместо них выведи только следующую строку:
⚠️ [b]Недостаточно информации.[/b] [USER=<responsibleId>]Исполнитель[/USER], пожалуйста, напиши пояснения.
- Не добавляй никаких других комментариев или пояснений.

Упоминание исполнителя:
- Возьми значение поля "assignee" из объекта currentTask.
- Возьми только значение ID поля "assignee".
- Выведи значение ID поля "assignee" в формате: [USER=<responsibleId>]Исполнитель[/USER]
- Не изменяй значение "assignee" и не используй другие поля JSON.

Выведи только результат в следующем формате:
[b]✅ SUMMARY:[/b]
<1-2 предложения>

[b]📝 TITLE:[/b]
❗️Релиз, указанный в задаче, не совпадает с фактическим.
1. ...
2. ...

Если предупреждение не требуется, строку с ❗️ не выводи.

Если информации недостаточно, вместо SUMMARY и TITLE выведи только:

⚠️ [b]Недостаточно информации.[/b] [USER=<responsibleId>]Исполнитель[/USER], пожалуйста, напиши пояснения.`;
}

async function processClosedTask(taskId) {
  const { task: mainTask, comments: mainComments } = await fetchTaskWithComments(taskId);
  const parentId = getParentIdFromTask(mainTask);
  const responsibleId = getResponsibleIdFromTask(mainTask);
  const groupId = getGroupIdFromTask(mainTask);
  const groupName = getGroupNameFromTask(mainTask);
  const timeLogs = await fetchTaskTimeLogs(taskId);
  let contextparentID = null;

  log('Closed task context loaded', { taskId, parentId, responsibleId, groupId, groupName, time_logs_count: timeLogs.length });

  if (timeLogs.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: 'empty_time_logs',
      task_id: taskId,
      time_logs_count: timeLogs.length,
    };
  }

  if (isCollabGroupName(groupName)) {
    return {
      ok: true,
      skipped: true,
      reason: 'collab_group_name',
      task_id: taskId,
      group_id: groupId,
      group_name: groupName,
    };
  }

  if (parentId && parentId !== '0') {
    const { task: parentTask, comments: parentComments } = await fetchTaskWithComments(parentId);
    contextparentID = { parentId, parentTask, parentTaskComments: parentComments };
    log('Parent task context loaded', { taskId, parentId });
  }

  const aiResponse = await coworkRequest('POST', '/chat/completions', {
    model: MODEL_NAME,
    messages: [{
      role: 'user',
      content: buildPrompt({ taskId, responsibleId, mainTask, mainComments, contextparentID }),
    }],
  });

  const aiComment = aiResponse?.choices?.[0]?.message?.content?.trim();
  if (!aiComment) throw new Error('Gemma returned empty comment');

  await bitrixCall('task.commentitem.add', {
    TASKID: taskId,
    FIELDS: {
      POST_MESSAGE: aiComment,
      AUTHOR_ID,
    },
  });

  return {
    ok: true,
    task_id: taskId,
    parent_id: parentId || null,
    responsible_id: responsibleId,
    group_id: groupId || null,
    group_name: groupName || null,
    time_logs_count: timeLogs.length,
    ai_comment: aiComment,
  };
}

async function handleWebhook(body) {
  const data = parseFormUrlEncoded(body);

  if (data.auth?.application_token !== WEBHOOK_TOKEN) {
    return { statusCode: 403, data: { ok: false, error: 'Invalid webhook token' } };
  }

  if (data.event !== 'ONTASKUPDATE') {
    return { statusCode: 200, data: { ok: true, ignored: true, reason: 'unsupported_event' } };
  }

  const taskId = getTaskIdFromOutgoingWebhook(data);
  if (!taskId) throw new Error('No task ID found');

  const updateBatch = await getLatestUpdateBatch(taskId);
  const responsibleChange = findLatestFieldChange(updateBatch, 'RESPONSIBLE_ID');
  const statusChange = findLatestFieldChange(updateBatch, 'STATUS');
  const actions = [];

  const previousResponsibleId = normalizeId(responsibleChange?.value?.from);
  if (previousResponsibleId) {
    const result = await addAccomplice(taskId, previousResponsibleId);
    actions.push({ branch: 'responsible_changed', ...result });
  }

  if (String(statusChange?.value?.to) === '5') {
    const result = await processClosedTask(taskId);
    actions.push({ branch: 'task_closed', ...result });
  }

  if (actions.length === 0) {
    return {
      statusCode: 200,
      data: {
        ok: true,
        ignored: true,
        reason: 'latest_update_has_no_tracked_fields',
        task_id: taskId,
        latest_fields: updateBatch.map(item => item.field),
      },
    };
  }

  return { statusCode: 200, data: { ok: true, task_id: taskId, actions } };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url.split('?')[0] === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OK');
      return;
    }

    if (req.method !== 'POST' || req.url.split('?')[0] !== '/webhook') {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    const result = await handleWebhook(await readBody(req));
    sendJson(res, result.statusCode, result.data);
  } catch (error) {
    log('Webhook failed', { error: error.message });
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
});
