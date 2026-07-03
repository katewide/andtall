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
Ты - профессиональный ассистент. Твоя задача - проанализировать данные задачи и написать краткий итог.

НИЖЕ ПРИВЕДЕНЫ ДАННЫЕ ЗАДАЧИ (JSON):
${taskJsonString}

НИЖЕ ПРИВЕДЕНЫ КОММЕНТАРИИ К ЗАДАЧЕ (JSON):
${commentsJsonString}

ЗАДАНИЕ:
На основе предоставленных JSON-данных (основная информация о задаче и история комментариев) сформируй результат. Если есть несоответствие данных задачи и комментариев, то ориентируйся на комментарии.

ЭТАП 1: ПРОВЕРКА ДОСТАТОЧНОСТИ ИНФОРМАЦИИ
Критически оцени, достаточно ли данных в полях description, title и comments для понимания сути проблемы и выполненных работ. 
- Считай информацию НЕДОСТАТОЧНОЙ, если содержательные текстовые поля пустые, содержат только приветствия, или если суммарная длина текста во всех полях и комментариях составляет менее 10 слов.
- Если информации недостаточно, переходи сразу к СЦЕНАРИЮ Б. Во всех остальных случаях выполняй СЦЕНАРИЙ А.

---

СЦЕНАРИЙ А: ИНФОРМАЦИИ ДОСТАТОЧНО
Сформируй результат строго в следующем формате, без вступлений и рассуждений:

[b]✅ SUMMARY:[/b]
В 1–2 предложениях кратко опиши суть задачи.
- Обязательно укажи: какая проблема или запрос были у клиента, и каким способом проблема была решена (или какие работы выполнены).
- Используй только факты из JSON. Ничего не выдумывай.
- ЗАПРЕЩЕНО использовать слова: «успешно», «полностью», «окончательно», «задача успешно решена», «вопрос закрыт» и любые их аналоги.

[b]📝 TITLE:[/b]
Предложи 2 варианта наименования задачи (каждый от 3 до 15 слов), максимально точно отражающих суть.
- Если суть задачи — консультация, начинай название со слов: «Консультация по...».
- Если суть задачи — действия (настройка, исправление, разработка), начинай со слов: «Проведение работ по...».
- ЗАПРЕЩЕНО использовать слова: «срочно», «важно», «помощь».

Проверка релиза (только для заголовков, начинающихся на "Обновление баз..."):
- Если в исходном названии задачи и в комментариях упоминаются номера релизов, и они отличаются, сразу после строки [b]📝 TITLE:[/b] выведи:
❗️Релиз, указанный в задаче, не совпадает с фактическим.

---

СЦЕНАРИЙ Б: ИНФОРМАЦИИ НЕДОСТАТОЧНО
Если информации мало, не выводи разделы SUMMARY и TITLE. Выведи строго одну строку:

⚠️ [b]Недостаточно информации.[/b] [USER=ID]Имя Фамилия[/USER], пожалуйста, напиши пояснения.
(где ID и Имя Фамилия — это данные исполнителя из поля "assignee" объекта taskJsonString).

---

ВЫВЕДИ ИТОГОВЫЙ РЕЗУЛЬТАТ ПО ОДНОМУ ИЗ ДВУХ СЦЕНАРИЕВ (НИКАКИХ ДРУГИХ СЛОВ И ПОЯСНЕНИЙ):
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
