const express = require('express');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

// Константы из окружения
const BASE_URL = process.env.BASE_URL || 'https://vibecode.bitrix24.tech';
const API_KEY = 'vibe_api_GFx4RJlY9HwGpWNskGCz03jKV6lZsWHn_3126a5'; 
const AI_ROUTER_URL = `${BASE_URL}/v1/chat/completions`;
const MODEL_NAME = 'bitrix/google/gemma-4-26B-A4B-it';

// Константа для отправки комментария через входящий вебхук (как вы предложили)
const WEBHOOK_COMMENT_URL = 'https://elros.bitrix24.ru/rest/38/kix51vmnh35rswwi/task.commentitem.add';
const AUTHOR_ID = 204;

// Хранилище для отладки
let lastRequest = {
  timestamp: null,
  method: null,
  url: null,
  headers: {},
  body: {},
  taskData: null,
  comments: [],
  aiResponse: null,
  error: null,
  lastHit: null
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.all('*', (req, res, next) => {
  const hitInfo = req.method + ' ' + req.url;
  console.log('🔥 HIT: ' + hitInfo);
  lastRequest.lastHit = hitInfo;
  lastRequest.timestamp = new Date().toLocaleString();
  lastRequest.method = req.method;
  lastRequest.url = req.url;
  lastRequest.headers = req.headers;
  lastRequest.body = req.body;
  
  if (req.url !== '/debug' && req.url !== '/health') {
      lastRequest.taskData = null;
      lastRequest.comments = [];
      lastRequest.aiResponse = null;
      lastRequest.error = null;
  }
  next();
});

app.post('/webhook', async (req, res) => {
  try {
    if (!API_KEY) throw new Error('API_KEY is not configured in environment');

    // Извлекаем ID задачи из входящего вебхука (поддерживаем разные форматы)
    const taskId = req.body.task_id || (req.body.document_id && req.body.document_id[2]) || req.query.task_id;

    if (!taskId) throw new Error('No task_id found');

    console.log('--- Starting AI Agent Flow for Task:', taskId, '---');

    // 1. СОБИРАЕМ КОНТЕКСТ (Задача + Комментарии)
    // Используем API-ключ для получения данных самой задачи
    const [taskRes, commentsRes] = await Promise.allSettled([
      axios.get(`${BASE_URL}/v1/tasks/${taskId}`, { headers: { 'X-Api-Key': API_KEY } }),
      axios.get(`${BASE_URL}/v1/tasks/${taskId}/comments`, { headers: { 'X-Api-Key': API_KEY } })
    ]);

    if (taskRes.status === 'rejected') {
        throw new Error('Failed to fetch task: ' + taskRes.reason.message);
    }
    
    const taskData = taskRes.value.data;
    const commentsData = (commentsRes.status === 'fulfilled') ? commentsRes.value.data : [];
    
    lastRequest.taskData = taskData;
    lastRequest.comments = commentsData;

    // 2. ФОРМИРУЕМ ПРОМПТ ДЛЯ GEMMA (передаем JSON напрямую)
    const taskJsonString = JSON.stringify(taskData, null, 2);
    const commentsJsonString = JSON.stringify(commentsData, null, 2);

    const prompt = `Ты - профессиональный ассистент. Твоя задача - проанализировать данные задачи и написать краткий итог.

НИЖЕ ПРИВЕДЕНЫ ДАННЫЕ ЗАДАЧИ (JSON):
${taskJsonString}

НИЖЕ ПРИВЕДЕНЫ КОММЕНТАРИИ К ЗАДАЧЕ (JSON):
${commentsJsonString}

ЗАДАНИЕ:
На основе предоставленных JSON-данных (основная информация о задаче и история комментариев) сформируй результат строго в следующем формате. Если есть несоответствие данных задачи и комментариев, то ориентируйся на комментарии.
[b]✅ SUMMARY:[/b]
В 1–2 предложениях кратко опиши суть задачи.
- Обязательно укажи:
- какая проблема или запрос были у клиента;
- каким способом проблема была решена или какие работы были выполнены.
- Не используй оценочные или шаблонные формулировки, такие как: «задача успешно решена», «работы успешно выполнены», «проблема полностью устранена», «вопрос закрыт» и аналогичные.
- Не используй слова «успешно», «полностью», «окончательно», «окончательно решена», если это прямо не указано в предоставленных данных.
- Используй только информацию, содержащуюся в JSON. Ничего не выдумывай и не добавляй от себя.
[b]📝 TITLE:[/b]
- Предложи 2 наиболее подходящих варианта наименования задачи.
- Каждый вариант должен содержать от 3 до 15 слов.
- Название должно быть кратким, но максимально точно отражать выполненную работу.
- Если основная суть задачи — консультация или предоставление информации, начинай название со слов «Консультация по...».
- Если основная суть задачи — выполнение работ, настройка, исправление, разработка, подключение, обновление или иные действия, начинай название со слов «Проведение работ по...».
- Не используй слова: «срочно», «важно», «помощь».
- Не используй общие или расплывчатые формулировки.
- Не добавляй никаких пояснений, вступлений, комментариев или рассуждений.
Проверка релиза (только для задач с наименованием, начинающимся на "Обновление баз...":
- Если в исходном названии задачи и в комментариях упоминаются номера релизов (версий), сравни их.
- Если номера релизов отличаются, сразу после заголовка 📝 TITLE: выведи отдельной строкой:
❗️Релиз, указанный в задаче, не совпадает с фактическим.
Если в названии задачи или комментариях номер релиза отсутствует либо определить его невозможно, предупреждение не выводи.
Проверка достаточности информации:
- Перед формированием результата оцени, достаточно ли информации для понимания проблемы и выполненных работ.
- Если в файлах JSON нет значениц длинее 3-х слов в desctiption, title, comments не пытайся делать предположения и не придумывай содержание.
- В этом случае не выводи разделы ✅ SUMMARY и 📝 TITLE.
- Вместо них выведи только следующую строку:
⚠️ [b]Недостаточно информации.[/b] [USER=<assignee>]Имя Фамилия[/USER], пожалуйста, напиши пояснения.
- Не добавляй никаких других комментариев или пояснений.

Упоминание исполнителя:
- После раздела 📝 TITLE (или после строки ⚠️, если информации недостаточно) отдельной строкой укажи исполнителя задачи.
- Возьми значение поля "assignee" из объекта "taskJsonString".
- Возьми только значение ID и значение (Имя Фамилия) поля "assignee". 
- Выведи значение ID поля "assignee". в формате:[USER=<assignee>]Имя Фамилия[/USER]
где "assignee" — значение поля "assignee".
- Не изменяй значение "assignee" и не используй другие поля JSON.
Выведи только результат в следующем формате:
[b]✅ SUMMARY:[/b]
<1–2 предложения>

[b]📝 TITLE:[/b]
❗️Релиз, указанный в задаче, не совпадает с фактическим.
1. ...
2. ...
Если предупреждение не требуется, строку с ❗️ не выводи.

Если информации недостаточно, вместо SUMMARY и TITLE выведи только:

⚠️ [b]Недостаточно информации.[/b] [USER=<assignee>]Имя Фамилия[/USER], пожалуйста, напиши пояснения.
`;

    console.log('Sending prompt to Gemma...');

    // 3. ЗАПРОС К GEMMA (через AI Router)
    const aiResponse = await axios.post(AI_ROUTER_URL, {
      model: MODEL_NAME,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' }
    });

    const aiComment = aiResponse.data.choices[0].message.content.trim();
    lastRequest.aiResponse = aiComment;
    console.log('Gemma responded:', aiComment);

    // 4. ОТПРАВКА КОММЕНТАРИЯ В ЗАДАЧУ ЧЕРЕЗ ВАШ ВЕБХУК
    console.log('Posting comment back to Bitrix24 via inbound webhook...');
    
    // Формат запроса для task.commentitem.add через вебхук:
    // { taskId: 123, fields: { POST_MESSAGE: "...", AUTHOR_ID: 204 } }
    await axios.post(WEBHOOK_COMMENT_URL, {
        taskId: taskId,
        fields: {
            "POST_MESSAGE": aiComment,
            "AUTHOR_ID": AUTHOR_ID
        }
    });

    console.log('--- Flow Completed Successfully! ---');
    res.json({ ok: true, ai_comment: aiComment });

  } catch (err) {
    const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('CRITICAL ERROR IN AGENT:', errorMsg);
    lastRequest.error = errorMsg;
    res.status(500).json({ ok: false, error: errorMsg });
  }
});

app.get('/debug', (req, res) => {
  const errorHtml = lastRequest.error ? '<div class="error"><b style="color:#ff5252">❌ Error:</b><pre>' + lastRequest.error + '</pre></div>' : '';

  const html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>AI Agent Debugger</title><meta http-equiv="refresh" content="3">' +
    '<style>' +
    'body { font-family: monospace; margin: 20px; background: #1e1e1e; color: #d4d4d4; }' +
    '.card { background: #252526; padding: 25px; border-radius: 8px; border: 1px solid #333; max-width: 1100px; margin: auto; }' +
    'h1 { color: #4fc1ff; border-bottom: 1px solid #333; padding-bottom: 10px; }' +
    'pre { background: #000; color: #9cdcfe; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 13px; border: 1px solid #333; }' +
    '.error { color: #f44747; background: #3e1a1a; padding: 10px; border-radius: 4px; margin-bottom: 15px; border: 1px solid #f44747; }' +
    '.label { color: #ce9178; font-weight: bold; margin-top: 25px; display: block; text-transform: uppercase; font-size: 0.85em; }' +
    '.status { color: #b5cea8; font-size: 1.1em; margin-bottom: 15px; }' +
    '</style></head><body>' +
    '<div class="card">' +
    '<h1>🚀 AI Agent Monitor</h1>' +
    '<div class="status">Last Hit: ' + (lastRequest.lastHit || 'None') + '</div>' +
    errorHtml +
    '<span class="label">1. Incoming Payload (from Robot):</span><pre>' + JSON.stringify(lastRequest.body, null, 2) + '</pre>' +
    '<span class="label">2. Task Context (Full JSON):</span><pre>' + JSON.stringify(lastRequest.taskData, null, 2) + '</pre>' +
    '<span class="label">3. All Comments (Full JSON):</span><pre>' + JSON.stringify(lastRequest.comments, null, 2) + '</pre>' +
    '<span class="label">4. AI Generated Comment:</span><pre style="color:#4ec9b0">' + (lastRequest.aiResponse ? lastRequest.aiResponse : 'Waiting for AI...') + '</pre>' +
    '</div></body></html>';
  res.send(html);
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(port, () => console.log('AI Agent running on port ' + port));
