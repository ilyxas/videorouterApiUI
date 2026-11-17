# Workflow v2: Steps, DAG, typed cards

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

- Workflow — упорядоченные Steps. Step содержит `nodes`, `edges`, `continueOnSuccess` (по умолчанию true). Отключение флага останавливает runner на границе Step.
- Node — определение API-карточки: стабильный `id`, `kind`, `operationId`, `op`, `model`, `parameters`, `inputs`, `quoteFacts` и editor state. `ImageCard`, `VideoCard`, `AudioCard` наследуют `BaseCard`. Тип определяется выходом, поэтому lip-sync/face-swap/avatar — Video, transcription — Text. `ApiCard` сохраняет произвольные операции.
- Edge содержит `from {stepId,nodeId,port,outputIndex}` и `to {nodeId,port,slot}`. Ссылка разрешена на тот же или любой предыдущий Step. Компилятор отклоняет циклы, будущие зависимости, неверные типы и неоднозначные входы. Готовые узлы выполняются последовательно в стабильном топологическом порядке; параллельной генерации и неявного fan-out нет.
- Registry/Strategy описывает режимы, входы, поля и проверки. Factory создаёт тип карточки. Input/output adapters преобразуют API-медиа в типизированные артефакты. Compiler строит план; Runner хранит состояния и checkpoints. SQLite остаётся repository через существующий слой сервера.

| Модуль | Ответственность |
|---|---|
| `public/operations.mjs` | Режимы Image/Video/Audio/Text/API, модельные возможности, обязательные входы и ограничения |
| `public/graph.mjs` | Классы карточек, Factory, схема v2, codec старого editor state, миграция и DAG compiler |
| `graph-engine.mjs` | Выполнение, разрешение inputs, materialization, pricing, artifacts, pause/resume/recover |
| `public/workflow-core.mjs` | Общая нормализация, previewEstimate, совместимость прежних contracts и экспорты v2 |
| `public/app.js` | Steps/cards, переключатели режимов, multiple refs, API Explorer, оценки, draft, история |
| `server.mjs` | Сохранение v2, prepare/tickets, start/resume/recover и существующие legacy endpoints |
| `engine.mjs`, `artifacts.mjs` | HTTP/multipart/async транспорт, idempotency header, image artifacts |

Каноническая схема сохраняется как v2. UI временно использует совместимую проекцию карточек с группами, что сохраняет существующие редакторы, budget picker и API Explorer. Классы карточек являются доменной оболочкой над сериализуемыми определениями, без несерилизуемых объектов в SQLite.

## References, стоимость и сохранность

URL используется напрямую. Небольшой локальный файл или base64 output передаётся как data URI внутри `input_references` либо другого media input. Upload fallback нужен только URL-only операции или когда inline body превысил бы 8 MiB. Локальный выбор файла не отправляет его внешнему провайдеру. Перед запросом проверяются наличие и тип источника, output index и известный TTL.

Preview цены работает отдельно от запуска, пропускает ещё не полученные references и сообщает об этом. Перед каждым Image/Video вызовом повторная оценка использует фактические разрешённые параметры; несовпадающие явные assumptions останавливают вызов. Неизвестная токенная стоимость остаётся неизвестной до результата. Оценка не является лимитом биллинга. История хранит quote, фактический request, remote ID, artifacts и известный cost.

Существующие v1 workflow, runs и assets не удалены. При сохранении открытого v1 создаётся отдельная v2-копия. Позиционные ссылки переводятся в стабильные ссылки на Node. Draft, API editor round-trip и история поддерживают v2. На паузе завершённые Steps неизменяемы; будущие можно редактировать, ревизии сохраняются.

Runner не повторяет неизвестный POST автоматически. Поддерживаемые create endpoints получают стабильный Idempotency-Key. Recover обращается только к существующему remote job через GET. Продолжение возможно на полностью завершённой границе Step; частично выполненный Step требует нового явного workflow для оставшихся операций. Ключи и чувствительные API-ответы остаются в памяти, не в Git.

## Проверки

- `node --test tests/*.test.mjs`: **28/28 passed**, включая 22 прежних регрессионных теста.
- Новые проверки: codec/classes/DAG; типы и циклы; точная двухэтапная цепочка с двумя references без upload; pause/edit/resume без повторения завершённых узлов; upload fallback; ошибки источника; preview без готового output; пустой локальный слот; сохранение имени и размеров файла.
- Изолированный браузерный проход с offline transport: создание шаблона, локальный PNG, API editor и возврат, quote, save/reload, Pause после Step 1, Continue до завершения. На 390×844 горизонтального overflow нет. [Снимок](evidence/11-workflow-v2-mobile.jpg).
- Реальный acceptance завершён; результаты ниже. После найденного в live-истории устаревшего remote status добавлено присвоение terminal status и assertion; затронутые 6 graph-тестов повторно прошли. Исправлены подпись media-ссылки и показ итогового статуса старых записей, `node --check public/app.js` прошёл. Повторных платных генераций для этих UI-исправлений не было.

## Границы проверки

Реестр охватывает описанные API media-операции, но все сочетания моделей/хостов не проверены реальными вызовами. Общие поля можно уточнять через API Explorer. Доступность модели определяет провайдер. Realtime/live остаются отдельными существующими инструментами. Маски inpainting не добавлялись. Полноценный свободный canvas с перетаскиванием рёбер не требуется для схемы DAG: UI задаёт связи через типизированные входы.

## Работающий сервис и Git

Выполнен `git init`. Baseline: `2665fd8`; реализация: `74d53d6`. `data/`, backups, env, секреты и ключи исключены из Git. Ни push, ни remote не создавались.

После проверки отсутствия активных заданий заменены только прежние разовые launchd jobs приложения. Новый server PID 25801, label `local.videorouterapiui.server.v2.1794949091`; proxy PID 25803, label `local.videorouterapiui.tailscale.v2.1794949091`. Это снимок на момент поставки. Отдельный HTTP-контроль подтвердил localhost и Tailscale после рестарта. Ключи из вложений подключены в память; 99 существовавших runs сохранены. Последующие acceptance runs добавлены отдельно.

- Mac: http://127.0.0.1:8791
- Tailscale: http://100.80.72.44:8791 (проверено с Mac; не с телефона)

`studio.sh` не менялся: его nohup-ограничение из документа 09 остаётся. Постоянный автозапуск не настраивался. Не перезапускать сервер при активных заданиях.

## Реальный acceptance

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
