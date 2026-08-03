import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------- config ---

const TELEGRAM_TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
const EFFORT = process.env.CLAUDE_EFFORT || "medium";
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4096);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 30);
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  "Ты — дружелюбный ассистент в Telegram. Отвечай по-русски, кратко и по делу. " +
    "Не используй Markdown-разметку: Telegram показывает текст как есть.";
const ALLOWED_USER_IDS = new Set(
  (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
// Резервная модель при отказе классификаторов безопасности.
// Поддерживается не всеми моделями — поэтому по умолчанию выключено.
const ENABLE_FALLBACKS = /^(1|true|yes|on)$/i.test(process.env.ENABLE_FALLBACKS || "");

// Клиент сам читает ANTHROPIC_API_KEY из окружения.
const claude = new Anthropic();

const API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_LIMIT = 4096;
const POLL_TIMEOUT_S = 50;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Не задана переменная окружения ${name}. См. .env.example`);
    process.exit(1);
  }
  return value;
}

// ------------------------------------------------------------- telegram ----

async function tg(method, body, { timeoutMs = 15_000 } = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

// Telegram режет сообщения длиннее 4096 символов — бьём по абзацам,
// затем по строкам, и только в крайнем случае по символам.
function splitMessage(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 <= limit) {
      current += (current ? "\n" : "") + line;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= limit) {
      current = line;
    } else {
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      current = chunks.pop() ?? "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function reply(chatId, text) {
  for (const chunk of splitMessage(text)) {
    // Без parse_mode: ответы модели ломают разметку Telegram непарными * и _.
    await tg("sendMessage", { chat_id: chatId, text: chunk });
  }
}

// «печатает…» живёт ~5 секунд, поэтому обновляем, пока ждём модель.
function startTyping(chatId) {
  const ping = () =>
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  ping();
  const timer = setInterval(ping, 4_000);
  return () => clearInterval(timer);
}

// ------------------------------------------------------------- диалоги -----

/** @type {Map<number, Array<{role: string, content: unknown}>>} */
const histories = new Map();

function getHistory(chatId) {
  if (!histories.has(chatId)) histories.set(chatId, []);
  return histories.get(chatId);
}

// Обрезаем старое, но история всегда должна начинаться с user-сообщения.
function trimHistory(history) {
  if (history.length <= HISTORY_LIMIT) return;
  history.splice(0, history.length - HISTORY_LIMIT);
  while (history.length && history[0].role !== "user") history.shift();
}

// --------------------------------------------------------------- claude ----

async function askClaude(history) {
  const params = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { effort: EFFORT },
    messages: history,
  };

  if (!ENABLE_FALLBACKS) {
    return claude.messages.stream(params).finalMessage();
  }

  // Если классификаторы безопасности отклонят запрос, Anthropic
  // переотправит его на резервную модель в рамках того же вызова.
  const stream = claude.beta.messages.stream({
    ...params,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  return stream.finalMessage();
}

function extractText(message) {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// ------------------------------------------------------------ обработка ----

const COMMANDS = {
  "/start":
    "Привет! Я бот на Claude. Просто напиши сообщение — отвечу.\n\n" +
    "/reset — очистить историю диалога\n" +
    "/id — показать твой Telegram ID\n" +
    "/help — эта справка",
  "/help":
    "Просто напиши сообщение — отвечу.\n\n" +
    "/reset — очистить историю диалога\n" +
    "/id — показать твой Telegram ID",
};

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = String(message.from?.id ?? "");
  const text = (message.text || "").trim();

  if (!text) {
    await reply(chatId, "Я понимаю только текст — картинки и файлы пока не умею.");
    return;
  }

  if (text === "/id") {
    await reply(chatId, `Твой Telegram ID: ${userId}`);
    return;
  }

  if (ALLOWED_USER_IDS.size > 0 && !ALLOWED_USER_IDS.has(userId)) {
    await reply(chatId, "Доступ к этому боту ограничен.");
    return;
  }

  const command = text.split(/\s+/)[0];
  if (COMMANDS[command]) {
    await reply(chatId, COMMANDS[command]);
    return;
  }

  if (command === "/reset") {
    histories.delete(chatId);
    await reply(chatId, "История диалога очищена.");
    return;
  }

  const history = getHistory(chatId);
  history.push({ role: "user", content: text });
  trimHistory(history);

  const stopTyping = startTyping(chatId);
  try {
    const response = await askClaude(history);

    if (response.stop_reason === "refusal") {
      history.pop(); // не сохраняем отклонённый запрос в контекст
      await reply(chatId, "Не могу ответить на этот запрос. Попробуй переформулировать.");
      return;
    }

    // Блоки ответа нужно возвращать модели без изменений — сохраняем целиком.
    history.push({ role: "assistant", content: response.content });

    const answer = extractText(response);
    if (!answer) {
      await reply(chatId, "Модель вернула пустой ответ. Попробуй ещё раз.");
      return;
    }

    await reply(chatId, answer);

    if (response.stop_reason === "max_tokens") {
      await reply(chatId, "[Ответ обрезан по лимиту длины — напиши «продолжи»]");
    }
  } catch (error) {
    history.pop();
    logError(error);
    await reply(chatId, formatUserError(error)).catch(() => {});
  } finally {
    stopTyping();
  }
}

// Текст ошибки от API — самое ценное при отладке конфига, не теряем его.
function apiErrorDetail(error) {
  const detail = error?.error?.error?.message ?? error?.error?.message;
  return typeof detail === "string" ? detail : error.message;
}

function logError(error) {
  if (error instanceof Anthropic.APIError) {
    console.error(
      `Claude API ${error.status}: ${apiErrorDetail(error)}\n` +
        `  model=${MODEL} effort=${EFFORT} fallbacks=${ENABLE_FALLBACKS}`,
    );
    return;
  }
  console.error("Ошибка обработки сообщения:", error);
}

function formatUserError(error) {
  if (error instanceof Anthropic.RateLimitError) {
    return "Слишком много запросов к модели. Подожди немного и повтори.";
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "Проблема с ключом Claude API — проверь ANTHROPIC_API_KEY на сервере.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Не удалось связаться с Claude API. Попробуй ещё раз.";
  }
  // 400 — почти всегда ошибка конфигурации, а не сбой. Показываем причину.
  if (error instanceof Anthropic.BadRequestError) {
    return `Claude API отклонил запрос:\n${apiErrorDetail(error)}\n\nПроверь настройки в .env (модель, effort, max_tokens).`;
  }
  if (error instanceof Anthropic.APIError) {
    return `Ошибка Claude API (${error.status}). Попробуй ещё раз.`;
  }
  return "Что-то пошло не так. Попробуй ещё раз.";
}

// Сообщения одного чата обрабатываем строго по очереди,
// разные чаты — параллельно.
const queues = new Map();

function enqueue(chatId, task) {
  const previous = queues.get(chatId) ?? Promise.resolve();
  const next = previous.then(task).catch((error) => {
    console.error(`Необработанная ошибка в чате ${chatId}:`, error);
  });
  queues.set(chatId, next);
  next.finally(() => {
    if (queues.get(chatId) === next) queues.delete(chatId);
  });
}

// ----------------------------------------------------------- главный цикл --

let running = true;

async function main() {
  // getUpdates не работает, пока установлен webhook.
  await tg("deleteWebhook", { drop_pending_updates: false });

  const me = await tg("getMe", {});
  console.log(`Бот @${me.username} запущен. Модель: ${MODEL}, effort: ${EFFORT}`);
  if (ALLOWED_USER_IDS.size > 0) {
    console.log(`Белый список: ${[...ALLOWED_USER_IDS].join(", ")}`);
  }

  let offset = 0;

  while (running) {
    let updates;
    try {
      updates = await tg(
        "getUpdates",
        { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] },
        { timeoutMs: (POLL_TIMEOUT_S + 15) * 1000 },
      );
    } catch (error) {
      if (!running) break;
      console.error("Ошибка getUpdates:", error.message);
      await sleep(3_000);
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      if (update.message) {
        enqueue(update.message.chat.id, () => handleMessage(update.message));
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\nПолучен ${signal}, останавливаюсь…`);
    running = false;
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}

main().catch((error) => {
  console.error("Фатальная ошибка:", error);
  process.exit(1);
});
