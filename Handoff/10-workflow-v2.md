# Workflow v2: Steps, DAG, typed cards, execution session

Поставка 17 ноября 2026 по прямому поручению Ильи: реализовать архитектуру и проверить два Steps — `Text → Image → Edit Image`, затем `Video from references` (output редактирования + локальный файл). Этот документ заменяет указание «сначала replan» из исторического документа 09. Начинать чтение с [README](README.md).

## Архитектура

```text
Workflow v2
  Step 1 [continueOnSuccess=true]
    ImageCard (text-to-image) ── images[0] ──> ImageCard (image-edit)
  Step 2
    ImageCard output из Step 1 ── input_references[0] ──> VideoCard
    local asset               ── input_references[1] ──> VideoCard
```

- Workflow — упорядоченные Steps. Step содержит `nodes`, `edges`, `continueOnSuccess`, `enabled` (оба по умолчанию true) и `view` (`cards`/`flow`). Continue=false останавливает runner после выполненного активного Step. Отключённые Steps не останавливают run.
- Node — определение API-карточки: стабильный `id`, `kind`, `operationId`, `op`, `model`, `parameters`, `inputs`, `quoteFacts` и editor state. `ImageCard`, `VideoCard`, `AudioCard` наследуют `BaseCard`. Тип определяется выходом, поэтому lip-sync/face-swap/avatar — Video, transcription — Text. `ApiCard` сохраняет произвольные операции.
- Edge содержит `from {stepId,nodeId,port,outputIndex}` и `to {nodeId,port,slot}`. Ссылка разрешена на тот же или любой предыдущий Step. Компилятор отклоняет циклы, будущие зависимости, неверные типы и неоднозначные входы. Готовые узлы выполняются последовательно в стабильном топологическом порядке; параллельной генерации и неявного fan-out нет.
- Registry/Strategy описывает режимы, входы, поля и проверки. Factory создаёт тип карточки. Input/output adapters преобразуют API-медиа в типизированные артефакты. Compiler строит план; Runner хранит состояния и checkpoints. SQLite остаётся repository через существующий слой сервера.

| Модуль | Ответственность |
|---|---|
| `public/operations.mjs` | Режимы Image/Video/Audio/Text/API, модельные возможности, обязательные входы и ограничения |
| `public/graph.mjs` | Классы карточек, Factory, схема v2, codec старого editor state, миграция и DAG compiler |
| `public/workflow-state.mjs` | Кандидаты сохранённых outputs, latest/pinned, reuse snapshot, разрешение/пропуск входов и preview выполнения |
| `graph-engine.mjs` | Выполнение, разрешение inputs, materialization, pricing, artifacts, pause/resume/recover |
| `public/workflow-core.mjs` | Общая нормализация, previewEstimate, совместимость прежних contracts и экспорты v2 |
| `public/app.js` | Steps/cards, переключатели режимов, multiple refs, API Explorer, оценки, draft, история |
| `server.mjs` | Сохранение v2, prepare/tickets, start/resume/recover и существующие legacy endpoints |
| `engine.mjs`, `artifacts.mjs` | HTTP/multipart/async транспорт, idempotency header, image artifacts |

Каноническая схема сохраняется как v2. UI временно использует совместимую проекцию карточек с группами, что сохраняет существующие редакторы, budget picker и API Explorer. Классы карточек являются доменной оболочкой над сериализуемыми определениями, без несерилизуемых объектов в SQLite.

## Управление Steps и сессия выполнения

18 ноября добавлены удаление непустого Step вместе со связями после подтверждения, ↑/↓ с проверкой порядка зависимостей и локальный для Step переключатель Flow/Карточки. Layout раскладывает DAG слева направо по топологическим колонкам; параллельные ветки располагаются вертикально. Квадраты показывают тип, режим, модель, статус и миниатюру; внешние входы подписаны. Нажатие квадрата открывает полную карточку под графом. Фоны карточек чередуются белый / `#f7f5fa`.

`enabled=false` исключает все вызовы Step: pricing, uploads и generation. По паре workflow ID + node ID берётся последний успешный output либо явно закреплённый run. Reused строки не создают новые кандидаты. Снимок источников фиксируется при prepare, включая пока включённые Steps, чтобы их можно было выключить до начала выполнения. Проверяется известный TTL и наличие локального файла. Reused row хранит `reusedFrom`, artifacts и cost=0; старый source cost виден отдельно. Удаление Step не удаляет runs/assets. Старые схемы без новых полей продолжают работать.

Недоступный источник убирается из inputs до pricing/materialization. Если обязательных входов недостаточно, зависимый Node получает skipped с причиной; пропуск распространяется по зависимостям, независимые узлы продолжаются. Для исчезнувшего reference пересчитываются номера `@ImageN` / `@VideoN` / `@AudioN`; если prompt явно требует удалённый reference, карточка пропускается. Сломанная конфигурация без отсутствующего источника остаётся обычной ошибкой валидации.

UI запускает и показывает run на странице workflow, включая медиа между Steps. Лёгкий polling не передаёт raw result/request и обновляет изменившиеся outputs, сохраняя проигрывание медиа. Во время running доступны enabled только будущих Steps и Continue/Pause; при pause редактируются только будущие Steps. Ревизия проверяется на сервере и отклоняет гонку с началом Step. Completed/reused/skipped префикс сохраняется при resume. Второй running run того же workflow запрещён.

Новые маршруты: `GET /local/workflow/:id/outputs` (кандидаты и active/last run), `GET /local/run/:id?view=workflow` (компактный статус), `POST /local/run/:id/control` (`revision`, `stepId`, `enabled`, `continueOnSuccess` или `pauseAfterCurrent`). Существующие prepare/run/resume используются с reuse snapshot. История, API Explorer и оценка остаются общими; budget исключает отключённые и заведомо skipped карточки.

## References, стоимость и сохранность

URL используется напрямую. Небольшой локальный файл или base64 output передаётся как data URI внутри `input_references` либо другого media input. Upload fallback нужен только URL-only операции или когда inline body превысил бы 8 MiB. Локальный выбор файла не отправляет его внешнему провайдеру. Перед запросом проверяются наличие и тип источника, output index и известный TTL.

Preview цены работает отдельно от запуска, пропускает ещё не полученные references и сообщает об этом. Перед каждым Image/Video вызовом повторная оценка использует фактические разрешённые параметры; несовпадающие явные assumptions останавливают вызов. Неизвестная токенная стоимость остаётся неизвестной до результата. Оценка не является лимитом биллинга. История хранит quote, фактический request, remote ID, artifacts и известный cost.

Существующие v1 workflow, runs и assets не удалены. При сохранении открытого v1 создаётся отдельная v2-копия. Позиционные ссылки переводятся в стабильные ссылки на Node. Draft, API editor round-trip и история поддерживают v2. На паузе завершённые Steps неизменяемы; будущие можно редактировать, ревизии сохраняются.

Runner не повторяет неизвестный POST автоматически. Поддерживаемые create endpoints получают стабильный Idempotency-Key. Recover обращается только к существующему remote job через GET. Продолжение возможно на полностью завершённой границе Step; частично выполненный Step требует нового явного workflow для оставшихся операций. Ключи и чувствительные API-ответы остаются в памяти, не в Git.

## Проверки

- **35 автоматических проверок прошли:** общий набор `node --test tests/*.test.mjs` дал 34/34, затем отдельно добавленный `node --test tests/workflow-session.test.mjs` — 1/1. В общий набор входят прежние 28 проверок. Все проверки используют offline transport; пакеты не устанавливались.
- Новые unit-сценарии: кодирование enabled/view/reuse и управление Step; запрет неверной перестановки; layout DAG; четыре references с двумя reused источниками; необязательный/обязательный отсутствующий вход; pin, private/expired output; revision/live controls/pause/resume; перенумерация ссылок в prompt.
- Новый HTTP integration: prepare snapshot, запрет второго active run, revision conflict, выключение будущего Step, компактный polling, pause/resume без дублирования, persisted outputs и reused image → video. Счётчик транспорта подтвердил ровно один image и один video вызов.
- Изолированный UI-проход: Flow с двумя квадратами и стрелкой, разные фоны, перемещение вниз/вверх, удаление непустого Step и связи, запуск без ухода из редактора, два inline outputs на паузе и Continue до completed. После обнаруженного сброса итоговых меток в «из истории» UI исправлен: completed/reused сохраняются для совпадающего output; синтаксис и затронутое отображение повторно проверены. [Снимок](evidence/14-step-flow-offline.jpg).
- На реальном run verified reused outputs и новый расход $0. Мобильный размер 390×844: `scrollWidth=innerWidth=390`. [Снимок](evidence/15-step-reuse-mobile.jpg). Старые доказательства API editor, local file и двухэтапного acceptance сохраняются в [11](evidence/11-workflow-v2-mobile.jpg) и [13](evidence/13-workflow-v2-live.jpg).

## Границы проверки

Реестр охватывает описанные API media-операции, но все сочетания моделей/хостов не проверены реальными вызовами. Общие поля можно уточнять через API Explorer. Доступность модели определяет провайдер. Realtime/live остаются отдельными существующими инструментами. Маски inpainting не добавлялись. Полноценный свободный canvas с перетаскиванием рёбер не требуется для схемы DAG: UI задаёт связи через типизированные входы.

## Работающий сервис и Git

Выполнен `git init`. Baseline: `2665fd8`; Workflow v2: `74d53d6`; управление Steps, selective execution и пять live-сценариев: `f4438cc`. `data/`, backups, env, секреты и ключи исключены из Git. Ни push, ни remote не создавались. Корневой AGENTS.md, появившийся отдельно во время работы, сохранён без изменений и не включён в коммит реализации.

18 ноября после проверки отсутствия активных заданий обновлены только прежние разовые launchd jobs приложения. Server PID 30339, label `local.videorouterapiui.server.v2.1794949091`; proxy PID 30341, label `local.videorouterapiui.tailscale.v2.1794949091`. Это снимок на момент проверки. Отдельная команда после рестарта подтвердила HTTP 200 localhost и Tailscale. Ключи из вложений подключены в память; все 107 существовавших runs сохранены. После новой серии — 112 runs, активных 0. Изолированный offline server остановлен, основной server + proxy оставлены работающими.

- Mac: http://127.0.0.1:8791
- Tailscale: http://100.80.72.44:8791 (проверено с Mac; не с телефона)

`studio.sh` не менялся: его nohup-ограничение из документа 09 остаётся. Постоянный автозапуск не настраивался. Не перезапускать сервер при активных заданиях.

## Реальный acceptance 17 ноября: Image → Edit → Video

Сохранён workflow **Acceptance v2 Gemini · Image → Edit → 2 references → Video**, ID `4922c714-bc4b-4718-9668-9a31f99a0c51`. Run `2da28611-0429-40ef-9d7b-a24decc84e51` завершён; оба Steps и три узла имеют `completed`.

1. Step 1: Gemini 2.5 Flash Image создал синий чайник, второй вызов добавил золотую полосу.
2. Step 2: `fal/seedance-2.0`, 5 секунд, 480p, 16:9, `provider.only=[fal]`, `allow_fallbacks=false` создал видео.
3. Фактический `input_references` видео содержит ровно два элемента. Побайтово проверено совпадение первого с output Edit, второго — с `tests/fixtures/reference.png` (локально созданный PNG 512×512 с оранжевым кругом). Вход Edit совпадает с output Generate. Все references отправлены data URI; внешних uploads **0**.

| Вызов | Стоимость, сообщённая API и учтённая приложением |
|---|---:|
| Image generate | $0.04185873 |
| Image edit | $0.04227614 |
| Reference video | $0.68931250 |
| Всего | **$0.77344737** |

Баланс кошелька до проверки $22.6808, после $21.8700, held $0. Уменьшение **$0.8108**, в пределах разрешённых $10. Оно больше суммы cost из ответов на $0.03735263; причина расхождения не установлена. Приложение показывает известные API costs, а не приписывает разницу отдельному вызову. Это ограничение сверки биллинга явно сохранено.

Первая попытка с `gpt-image-1` остановилась на первом вызове: HTTP 502, оба upstream вернули 400. На проверке сразу после ошибки баланс не изменился; Edit и Video в той попытке не запускались. Повторять тот же запрос автоматически не стали, второй явный acceptance выполнен на документированной Gemini.

Машиночитаемые факты: [12-workflow-v2-live.json](evidence/12-workflow-v2-live.json). Итоговый экран после исправления подписей: [13-workflow-v2-live.jpg](evidence/13-workflow-v2-live.jpg). Ссылка на видео хранится в run и JSON evidence; она может истечь. Изолированный offline server остановлен, основной server + proxy оставлены работающими.

Источники контрактов: [API overview](https://videorouter.sh/docs/api-reference), [Images](https://videorouter.sh/docs/api-reference-images), [Image edit](https://videorouter.sh/docs/image-edit), [Video](https://videorouter.sh/docs/api-reference-video). Документация и бесплатные pricing endpoints использовались для подготовки запросов; окончательная проверка — фактический run.

## Пять реальных сценариев 18 ноября: active / reused Steps

Все пять прошли на одном стабильном workflow ID `05061997-1672-4bab-944b-aa3c4601f7a9`, сохранённом как **Проверка · 4 references — active / reused**. Каждый run содержит собственную конфигурацию; история сохраняет все пять вариантов. Использованы только синтетические предметы: синий чайник, коралловая ваза, апельсин, зелёный лист в белой чашке.

| Сценарий | Run ID | Проверенный результат | API cost |
|---|---|---|---:|
| 01 — базовые источники | `4e6a1bf2-6599-4c36-bc8d-5a221e3d7da2` | 4 активных Image Steps; выключенный Video без output — skipped | $0.16745114 |
| 02 — mixed references | `3206160c-c39f-491d-9f3a-856828e5b8eb` | 2 Image reused + 2 новых → Video с 4 references | $0.77303731 |
| 03 — pin старого output | `8d45253a-c471-4b04-a157-0f561599881f` | Orange из run 01, хотя есть новый из 02; только Leaf генерируется; Video reused | $0.04186316 |
| 04 — отсутствующий output | `1785b727-3b06-46c3-a2e1-68f6a8d368de` | Disabled Ghost и зависимый Edit skipped; необязательный пятый вход убран; Video использует 4 сохранённых reference | $0.68931250 |
| 05 — управление running | `d6843d4a-43bd-4c80-8e89-3d621a58f4f0` | Vase выключен до его старта, Pause после Teapot, Leaf переставлен перед Orange, resume; 2 новых + 2 reused → Video | $0.81041528 |

В последнем run Orange закреплён на run 01; новые Teapot и Leaf, сохранённые Vase и Orange поступили из четырёх разных Steps. Проверено точное совпадение bytes/data URI всех четырёх входов каждого из трёх видео с соответствующими artifacts. У reused/skipped строк нет request, estimate и technical calls, cost=0. Внешних uploads — **0**. Всего сгенерированы **9 изображений Gemini 2.5 Flash Image и 3 видео fal/seedance-2.0**, 5 секунд, 480p, 16:9, fal-only без fallback. Последнее видео отображается inline; browser metadata: 5.056 секунды, readyState=4, ошибок медиа нет. На кадре видны все четыре предмета.

Перед серией получена актуальная бесплатная оценка видео $0.689312; Gemini имеет неизвестную до ответа токенную цену. API costs всей серии **$2.48207939**. Кошелёк **$21.6240 → $19.0672**, уменьшение **$2.5568**, available=$19.0672, held=$0 на финальной сверке. Разница с API costs **$0.07472061** остаётся неатрибутированной; повторяющийся факт задержанного settlement учтён в runner, но причина расхождения суммы не установлена. С прежним acceptance потрачено **$3.3676 из $10**, остаток **$6.6324**. Лимит этой серии был $4.

Повторяемый runner: `tests/live-workflow-scenarios.mjs`. Без флага он только печатает план. Для нового платного прогона нужны отдельное разрешение на этот прогон, подключённые в Studio ключи и явные `--run-live --budget=4`. Budget guard использует максимум из сообщённых costs, изменения баланса и available, плюс резерв следующего сценария; итоговая сверка ожидает settlement. Это ограничитель запуска следующих сценариев, не жёсткий провайдерский лимит токенов. Скрипт записывает ID сразу в `data/live-checks/`; автоматически не повторяет неизвестные POST. Уточнения бюджетного guard внесены по наблюдению задержанного биллинга, проверены синтаксически, без нового платного прогона.

Доказательства: [JSON пяти сценариев](evidence/17-step-live-scenarios.json), [финальный Flow и видео](evidence/16-step-four-reference-video.jpg), [мобильный reused Step](evidence/15-step-reuse-mobile.jpg). API keys, raw requests и медиафайлы в Git не добавлялись. Полная платная матрица всех моделей не выполнялась.
