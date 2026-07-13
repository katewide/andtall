const express = require('express');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

const BASE_URL = process.env.BASE_URL;
const API_KEY = process.env.API_KEY;
const AI_ROUTER_URL = `${BASE_URL}/v1/chat/completions`;
const MODEL_NAME = 'bitrix/google/gemma-4-26B-A4B-it';

const WEBHOOK_COMMENT_URL = process.env.WEBHOOK_COMMENT_URL;
const AUTHOR_ID = Number(process.env.AUTHOR_ID);
const REQUIRED_ENV_VARS = ['BASE_URL', 'API_KEY', 'WEBHOOK_COMMENT_URL', 'AUTHOR_ID'];

function validateConfig() {
  const missingVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

  if (missingVars.length > 0) {
    throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
  }

  if (!Number.isFinite(AUTHOR_ID)) {
    throw new Error('AUTHOR_ID must be a number');
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function getTaskId(req) {
  return req.query.task_id;
}

function getParentId(req) {
  return req.query.parent_id;
}

async function fetchTaskWithComments(taskId) {
  const headers = { 'X-Api-Key': API_KEY };

  const [taskRes, commentsRes] = await Promise.allSettled([
    axios.get(`${BASE_URL}/v1/tasks/${taskId}`, { headers }),
    axios.get(`${BASE_URL}/v1/tasks/${taskId}/comments`, { headers })
  ]);

  if (taskRes.status === 'rejected') {
    throw new Error(`Failed to fetch task ${taskId}: ${taskRes.reason.message}`);
  }

  return {
    task: taskRes.value.data,
    comments: commentsRes.status === 'fulfilled' ? commentsRes.value.data : []
  };
}

function buildPrompt({ taskId, mainTask, mainComments, contextparentID }) {
  const context = {
    currentTaskId: taskId,
    currentTask: mainTask,
    currentTaskComments: mainComments
  };

  return `Ты - профессиональный ассистент. Твоя задача - проанализировать данные задачи и написать краткий итог.

НИЖЕ ПРИВЕДЕН КОНТЕКСТ ЗАДАЧИ (JSON):
${JSON.stringify(context, null, 2)}

НИЖЕ ПРИВЕДЕН КОНТЕКСТ РОДИТЕЛЬСКОЙ ЗАДАЧИ (JSON):
${JSON.stringify(contextparentID, null, 2)}

Правила анализа:
- Основной объект анализа - currentTask и currentTaskComments.
- Если контекст родительской задачи не равен null, используй parentTask и parentTaskComments только как дополнительный контекст.
- Если есть несоответствие данных задачи и комментариев, ориентируйся на комментарии.
- Используй только информацию, содержащуюся в JSON. Ничего не выдумывай и не добавляй от себя.

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
- Не используй слова: "срочно", "важно", "помощь".
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
⚠️ [b]Недостаточно информации.[/b] [USER=<assignee>]<ФИО сотрудника>[/USER], пожалуйста, напиши пояснения.
- Не добавляй никаких других комментариев или пояснений.

Упоминание исполнителя:
- Возьми значение поля "assignee" из объекта currentTask.
- Возьми только значение ID поля "assignee".
- Выведи значение ID поля "assignee" в формате: [USER=<assignee>]<ФИО сотрудника>[/USER]
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

⚠️ [b]Недостаточно информации.[/b] [USER=<assignee>]<ФИО сотрудника>[/USER], пожалуйста, напиши пояснения.`;
}

app.post('/webhook', async (req, res) => {
  try {
    const taskId = getTaskId(req);
    if (!taskId) throw new Error('No task_id found');

    const parentId = getParentId(req);
    const { task: mainTask, comments: mainComments } = await fetchTaskWithComments(taskId);

    let contextparentID = null;

    if (parentId && parentId !== '0') {
      const { task: parentTask, comments: parentComments } = await fetchTaskWithComments(parentId);

      contextparentID = {
        parentId,
        parentTask,
        parentTaskComments: parentComments
      };
    }

    const prompt = buildPrompt({
      taskId,
      mainTask,
      mainComments,
      contextparentID
    });

    const aiResponse = await axios.post(
      AI_ROUTER_URL,
      {
        model: MODEL_NAME,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' }
      }
    );

    const aiComment = aiResponse.data.choices[0].message.content.trim();

    await axios.post(WEBHOOK_COMMENT_URL, {
      taskId,
      fields: {
        POST_MESSAGE: aiComment,
        AUTHOR_ID
      }
    });

    res.json({
      ok: true,
      task_id: taskId,
      parent_id: parentId || null,
      ai_comment: aiComment
    });
  } catch (err) {
    const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error('Agent error:', errorMsg);
    res.status(500).json({ ok: false, error: errorMsg });
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

validateConfig();

app.listen(port, () => {
  console.log(`AI Agent running on port ${port}`);
});
