# AI Time Stamp

OrangeMonkey / Tampermonkey userscript: перед отправкой сообщения в чат ИИ вставляет локальную метку времени `[YYYY-MM-DD HH:MM:SS]`.

Модели часто не знают актуальное время пользователя. Скрипт добавляет его в текст **на Enter / клик Send**, не при каждом нажатии клавиши.

## Зачем

На grok.com, chatgpt.com и chat.deepseek.com поле ввода — SPA. Модель не видит системные часы браузера. Скрипт префиксирует промпт меткой, чтобы в ответе можно было опираться на «сейчас».

Панель — маленький квадрат **+** в правом нижнем углу; клик разворачивает отладку (скан форм, лог, Stamp now).

**Из коробки работает без конфига и без sink.** Три сайта зашиты в userscript (тот же набор, что в `config.example.json`). Enter / клик Send → timestamp. Sink для обычной работы не нужен.

## Что есть

| Компонент | Назначение |
|-----------|------------|
| `ai-time-stamp.user.js` | Userscript: сайты, stamp на Enter/Send, мини-панель |
| `sink.py` | Локальный sink `127.0.0.1:8766`: лог на диск + раздача `control/config.json` |
| `start_sink.bat` | Запуск sink на Windows |
| `control/config.example.json` | Шаблон конфига (сайты, селекторы, порт) |

Логи на диск: `tmp/log.jsonl` (не в git).

## Сайты

| Сайт | Поле ввода | Отправка |
|------|------------|----------|
| [grok.com](https://grok.com) | `[role="textbox"][aria-label="Ask Grok anything"]` | Enter |
| [chatgpt.com](https://chatgpt.com) | `#prompt-textarea` | Enter / Send |
| [chat.deepseek.com](https://chat.deepseek.com) | `textarea[name="search"][placeholder="Message DeepSeek"]` | Enter / клик `div.ds-button--circle` (SVG `M8.3125`) |

DeepSeek — React-controlled textarea: stamp в том же тике, что Send, не попадает в state. Поэтому событие перехватывается, пишется timestamp, пауза `submit_delay_ms`, затем клик Send.

## Быстрый старт

1. Установи `ai-time-stamp.user.js` в **OrangeMonkey** / Tampermonkey
2. Открой grok.com / chatgpt.com / chat.deepseek.com
3. Панель: квадрат **+** справа снизу. `sink:off` можно игнорировать.

Python, конфиг и sink не требуются.

## Нужен ли sink?

**Нет, для штампа времени — нет.** Userscript сам находит поле, ловит Enter / Send и вставляет метку.

Sink (`sink.py` / `start_sink.bat`) — только отладка и диск:

| Зачем | Без sink | С sink |
|-------|----------|--------|
| Timestamp на Enter / Send | да | да |
| Grok / ChatGPT / DeepSeek из коробки | да (зашито в `.user.js`) | да (можно переопределить `config.json`) |
| Scan forms / Copy log (буфер) | да | да |
| Лог в `tmp/log.jsonl` | нет | да |
| Живой конфиг селекторов без правки `.user.js` | нет | да, `GET /config` |

`sink:off` в панели — нормально, если sink не запущен.

Опционально, если нужен файл лога или правка селекторов без JS:

1. Python 3.10+
2. Скопируй `control/config.example.json` → `control/config.json` (как `browser_config` в vk-wall-capture)
3. `python sink.py` или `start_sink.bat` — окно не закрывай
4. Обнови вкладку чата; в панели `sink:ok`

Health-пинги в консоль sink не пишутся.

## Конфиг (как в ../vk)

Живой файл: **`control/config.json`** (gitignore). Шаблон: **`control/config.example.json`**.

Sink читает конфиг при старте и отдаёт его userscript с `GET /config`. Если `config.json` нет — берётся example.

После правки:

1. Перезапусти `sink.py`
2. Обнови вкладку чата (userscript подхватит конфиг)

Порт sink в userscript зашит (`http://127.0.0.1:8766` и `@connect`). Если меняешь `sink.port`, поправь оба места в `ai-time-stamp.user.js`.

### Что править, если сайт поменял вёрстку

Открой `control/config.json` → массив `sites`.

| Сломалось | Куда смотреть | Как чинить |
|-----------|---------------|------------|
| Поле ввода не находится, панель `composer: —` | `sites[].match` | Открой чат → разверни панель → **Scan forms** / **Copy log**. Возьми `id`, `role`, `aria_label`, `placeholder`, `name`, `tag` из дампа. Добавь правило в `match` (первое видимое побеждает). |
| Enter шлёт без времени, кнопка Stamp now работает | `react_controlled` | Поставь `true` — перехват Enter/click, stamp, пауза, повтор send. |
| Клик мышью по Send без timestamp | `sites[].send` | В DevTools: кнопка Send. Пропиши `path_d_prefix` (начало `d=` у SVG) и/или `class_contains`. Для DeepSeek: `M8.3125` + `ds-button--circle`. |
| Сообщение уходит раньше, чем успевает timestamp | `stamp.submit_delay_ms` | Увеличь (80 → 120–200). |
| Нужен stamp уже при наборе | `stamp.prefix_on_input` | `true` (по умолчанию выключено). |
| Новый сайт | `sites` + шапка userscript | Добавь объект в `sites` (`id`, `host` — JS regex string, `match`). В `ai-time-stamp.user.js` добавь `// @match https://новый-хост/*`. |
| Панель сразу большая | `panel.collapsed` | `true` — квадрат `+`. |

Правила `match` (все указанные поля должны совпасть):

- `tag`, `id`, `name`, `role`, `placeholder`, `testid`, `selector`
- `aria_label` — точное
- `aria_label_re` / `placeholder_re` — regex (без `//`, флаг `i`)

`host` — строка для `new RegExp(host, "i")`, например `"(^|\\.)deepseek\\.com$"`.

Формы на странице можно снять без правки кода и без sink: **Scan forms** / **Copy log** (панель и буфер). В `tmp/log.jsonl` пишется только если sink запущен.

## Безопасность

- Sink слушает только **localhost**
- Не коммить `control/config.json`, `tmp/`, логи
- Userscript не уходит в сеть кроме `127.0.0.1`

## Сделано с помощью

Собрано **с помощью [Grok](https://x.ai/) (xAI)** — код, отладка DeepSeek React send, sink и документация.

## Лицензия

[Apache License 2.0](LICENSE) — как у соседнего [vk-wall-capture](https://github.com/efimbu/vk-wall-capture): permissive (коммерция, модификация, распространение; сохранить notice).

Copyright 2026 the contributors
