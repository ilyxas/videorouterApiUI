# Тесты: описание, запросы агентам и результаты

Этот документ хранит назначение проверок, точные входы и результаты конкретных прогонов. README — только навигация; актуальная архитектура находится в [Handoff/10-workflow-v2.md](../Handoff/10-workflow-v2.md).

## Grok CLI provider · 20 November 2026

**94 distinct automated checks passed across the full initial pass and focused reruns.** The initial `node --test tests/*.test.mjs` passed 90 of 92 tests. One new failure exposed intermediate-file import before final-path validation; the adapter now validates every output before importing any. Another failure was an incorrectly hand-built portable workflow fixture; the test now uses the real exporter. Focused reruns passed. A new UI check found an invalid model/mode rendering fallback and passed after its correction. A final zero-based Grok reference-label case passed alongside the existing WAN reference-remapping regression. The existing isolated HTTP library test now also checks that `/grok-profile.mjs` is served as JavaScript; it passed after the browser check exposed the missing static route. Unrelated successful tests were not rerun. Registry consistency and modified JavaScript syntax checks passed.

`tests/grok-cli.test.mjs` covers mode/parameter validation, duration/resolution/reference limits, $0 quotes, UTF-8 streaming events, imported local artifacts, per-attempt idempotency, all five media modes, intermediate images, invalid output paths, incorrect video tool parameters, incomplete agent endings, contract import/preflight, pause/resume, recovery without another spawn, and absent/reused references. `tests/persistence.test.mjs` covers model controls, retained selected inputs, local status, and cost display. Existing tests cover VideoRouter, webhook/polling, estimates, history, import/export, DataCards, selective Steps, and saved output reuse. Process/session recovery was tested with a fake process, not by killing a real generation.

**Real acceptance run:** installed Grok CLI 1.0.89, isolated Studio on port 18830, run `a48febac-2bd6-49be-bf62-36eb13d5851c`. No VideoRouter keys were configured. A four-Step workflow generated a blue mug, edited it red, paused for inspection, resumed, and completed all three video modes. All five cards produced registered local final artifacts; the run cost was $0 additional. Reference-video composition retained one intermediate image; text-to-video retained two. A preceding one-image probe verified the streaming protocol and revealed that the installed video tool is `reference_to_video`, not `video_gen`.

| Card | Actual tools | Requested video | Observed output |
|---|---|---|---|
| Text → image | `image_gen` | — | Local JPEG, blue mug |
| Image edit | `image_edit` | — | Local JPEG, red mug |
| Two references → video | `image_edit`, `reference_to_video` | 3 s, 720p, 16:9 | MP4, 1280×720, 24 fps, 3.041667 s |
| Image → video | `reference_to_video` | 3 s, 480p, 16:9 | MP4, 736×400, 24 fps, 3.041667 s |
| Text → video | `image_gen`, `image_edit`, `reference_to_video` | 3 s, 480p, 16:9 | MP4, 848×480, 24 fps, 3.041667 s |

Dimensions and duration were read with ffprobe. The acceptance prompts requested simple mugs and a drifting paper boat, not a complex continuity benchmark. This proves orchestration and artifact delivery, not that Grok always obeys creative intent or exact pixel dimensions. The 15-second and 14-reference boundaries were validated offline, not generated live. Test outputs and session metadata remain in the isolated temporary directory and Grok's own session store; they were not imported into the production library.

The browser check verified Settings installation/credential status, the saved completed workflow, global-graph card opening, supported video modes/resolutions, two ordered references, and $0 cost. Local videos reported readyState 4 and the expected dimensions/duration; the reference video's native player accepted Play. [UI evidence](../Handoff/evidence/grok-cli-workflow.jpg). The temporary viewport was reset, the tab closed, and the isolated test server stopped. Production activation was approved by Ilya and completed through the existing launchd job. Both Grok models and their JavaScript module are available. Before/after hashes match for all 178 workflow/run/DataCard records and 81 asset registrations; the same paused run and proxy PID were preserved. The 145 completed, 14 failed, and one paused run remain unchanged, with no running jobs. VideoRouter keys are disconnected as expected and require reconnection. A separate `./studio.sh status` confirmed localhost and Tailscale availability. No production generation was started.

## Private repository publication · 20 November 2026

The first-publication review checked all 103 project files selected by Git and all reachable historical blobs (267 working-tree/historical blobs in total). A targeted credential-pattern scan found no candidates; no database, backup directory, or environment/key file was tracked, and no selected file exceeded 10 MiB. `git diff --check` passed. GitHub reported `isPrivate: true` for `ilyxas/videorouterApiUI` before uploading history. These are packaging checks, not a comprehensive secret audit. Application code was not changed for publication; the existing feature verification below was retained without rerunning successful tests. No paid requests, browser tests, or service restart were performed.

## LocationCards · 20 November 2026

**68 distinct focused checks passed.** The initial run passed 67 and exposed a new test-fixture mistake: it passed the export wrapper to the importer instead of its `workflow` property. Correcting that fixture and rerunning only the failed case passed. No production-code correction was needed for that failure. Command: `node --test tests/data-cards.test.mjs tests/persistence.test.mjs tests/workflow-contract.test.mjs tests/workflow-contract-natural.test.mjs tests/workflow-contract-limits.test.mjs tests/graph.test.mjs tests/library.test.mjs`.

New coverage includes LocationCard inheritance/factory selection, location fields and role validation, shared ID uniqueness, immutable saved card kind, combined character/location snapshots and context, import/export and missing-file behavior, distinct ordered references in synthetic image/video execution, quote/submission equivalence, library isolation/duplication/deletion, local HTTP persistence, location UI creation and editing, media selection, graph types, and reference cleanup. Existing tests cover CharacterCards, estimates, paused execution, output reuse, graph layout, contract limits, and agent fixtures. External generation was mocked; production data was not mutated.

An isolated Studio at port 18829, seeded with synthetic character/location profiles and PNG fixtures, was checked in the browser. Locations navigation, location-specific fields, described mixed API input choices, separate graph colors, and tap-to-edit for LocationCard snapshots passed. A missing navigation icon found in the visual pass was corrected and verified. At 393 × 852, the two-Step graph showed two source cards and two API cards, one character edge and two location edges, and no horizontal overflow (355 px client/scroll width). Both PNG previews loaded. [Mobile screenshot](../Handoff/evidence/location-cards-mobile.jpg). The viewport was reset and the temporary server stopped. Native iPhone Safari was not tested.

The updated shared `vrapiwf-director` passed the standard `skill-creator/scripts/quick_validate.py`, reference-link checks, and preservation checks for the original model profile, WAN prompt guidance, directing guidance, and real asset snapshot. No fresh independent agent evaluation or paid generation was performed.

**Production activation:** Ilya approved the restart and will reconnect both keys. With no running jobs, the backend was replaced while preserving the existing Tailscale proxy. A non-persisting `/local/workflow/export` probe accepted a LocationCard and preserved its `layout`. Before/after SHA-256 snapshots of full saved workflow, run, DataCard, and asset-registration records matched; the same single run remained paused. API and management key flags were false as expected. A separate `./studio.sh status` passed for localhost and Tailscale after activation. No saved records or media were changed and no generation was started. Current process identifiers are recorded in [Handoff](../Handoff/10-workflow-v2.md).

## Mobile Workflow Flow · 20 November 2026

The initial wrapped-row presentation was superseded after user feedback about its arrows. The current implementation uses a vertical layered DAG with a separate Step-label column, top/bottom ports, rounded routes, and side lanes for links that skip layers. It preserves the 70% mobile scale, full graph height, and existing card editors. Wide parallel branches may require horizontal scrolling.

The focused command `node --test --test-name-pattern='global layout|vertical mobile DAG|character workflow UI' tests/data-cards.test.mjs tests/persistence.test.mjs` passed all three checks. The mobile case covers widths of 320, 393, 430, and 760 px, multiple characters, parallel branches, an eight-edit chain, long dependencies, and an empty graph. Assertions check canvas/group bounds, non-overlapping cards, downward orthogonal routes, top/bottom ports, no route intersections with cards or Step-label areas, preserved edges, and an unchanged workflow definition. UI checks cover selected-edge styling, connection labels, and the existing editor output. JavaScript syntax passed. After adjusting fan-in/fan-out bend ordering during the visual pass, the affected geometry test passed again; unrelated successful tests were not repeated.

Browser verification used the existing five-Step workflow at 393 × 852. Cards measured 123.195 px; the graph's client and scroll sizes matched at 355 × 963 px, with all five cards and four incoming video connections visible in the full graph. Tapping the leaf image opened its editor/result, highlighted its one connection, dimmed the other three, and displayed the exact target slot (`input_references [3]`). Tapping again cleared selection. At 1280 × 900, cards returned to 176 px and horizontal desktop layout. The temporary viewport override was reset. [Current mobile screenshot](../Handoff/evidence/workflow-flow-mobile.jpg).

No workflow execution, paid generation, backend restart, or library mutation was performed. Native iPhone Safari was not tested. The checks do not guarantee zero edge crossings for arbitrary non-planar graphs; they verify routing around cards/labels and preservation of dependencies.

## CharacterCards and global Flow · 19 November 2026

**Offline character context and skill update:** the installed `vrapiwf/references/character-context.json` was compared with the production `createLibrary().dataCardContext()` result using a read-only connection to the real library. They match: Kira has nine images and one base video, and all ten registered files exist with compatible MIME types. A temporary two-Step workflow used a real character image for Nano Banana 2 Edit, then combined its generated output with another character image for Wan 3.0 Prime. The original `validateWorkflowContract` reported `importValid: true`, `executionPreflight.valid: true`, one DataCard, two API cards, and no warnings. Updated skill metadata/reference links passed focused checks; hashes confirm the model allowlist and creative/image/WAN guidance were preserved. The standard `quick_validate.py` could not run because the Python environment lacks PyYAML; no dependency was installed. This check did not execute generation, import a workflow into the live database, make HTTP requests, or independently evaluate another agent's behavior. The temporary workflow is verification input, not an additional user workflow or a production example in the skill.

**82 distinct named offline checks passed across the initial pass and targeted reruns.** The initial 80-case run passed 53, found two fixture assertion issues and the UI harness's single-import assumption, and encountered localhost sandbox restrictions in HTTP tests. The assertions now compare serialized JSON slot semantics and tolerate floating-point currency totals; the harness imports the new modules. All 27 failed or blocked cases then passed with permission to run isolated localhost servers. Two additional character UI rendering/handler checks passed. Successful unrelated checks were not repeated. The filtered Node report also counts five files with no matching tests; those are not included in the 82 named checks.

`tests/data-cards.test.mjs` covers abstract DataCard behavior, identity/type validation, editor round trips, Step movement, layout, explicit removal, portable reconnection, missing files, contract readiness, two-character execution with four ordered final-video references, quote/submission equivalence, paused snapshot edits, standalone Step reuse, audio samples, base videos, library isolation/deletion, and isolated HTTP persistence. All provider requests use synthetic transport. Existing regression cases cover previous workflows, import/export/history, webhook/polling, API editing, budgets, and pause/resume behavior.

The new UI tests in `tests/persistence.test.mjs` exercise character selection, duplicate prevention, snapshot editing, removal, global graph rendering, API media-editor rendering, and estimate invalidation after a changed character file. They do not substitute for a visual browser check.

- New feature tests: `node --test tests/data-cards.test.mjs`.
- UI regression tests: `node --test tests/persistence.test.mjs`.
- Registry consistency: `node contracts/workflow/registry.mjs --check` passed; no API operation was added.
- Modified application/server/runner/validator JavaScript syntax checks passed.
- **Initial browser limitation:** local browser creation and browser inventory reported “Local browser access is unavailable for this chat” during this delivery. The isolated UI fixture used only synthetic profiles and tiny image files, with external APIs disabled. The later global graph browser check is documented above; the remaining CharacterCard UI surfaces have not received a fresh visual pass.
- No real uploads to providers, paid generation, fresh independent LLM contract evaluation, or production database test writes occurred. Library files and production runs were not removed.
- **Activation:** Ilya approved the production restart. Server PID `91802` was launched through transient job `local.videorouterapiui.server.characters.1795101009`; proxy PID `5601` was left running. A separate post-restart command confirmed unchanged hashes of saved workflows and run summaries, the same paused run, HTTP 200 for both CharacterCard endpoints and both new browser modules, and successful localhost/Tailscale status checks. API and management key flags are false as expected; the user will reconnect them. The temporary UI fixture server was stopped.

## Как запускать

Все команды выполняются из корня проекта. Обычные `.test.mjs` используют временные данные и offline transport; рабочие workflows и внешние генерации не затрагиваются.

| Проверка | Команда |
|---|---|
| Полная автоматическая матрица | `node --test tests/*.test.mjs` |
| Сборка заданных графов по контракту | `node --test tests/workflow-contract.test.mjs` |
| Граничная глубина и длина цепочки | `node --test tests/workflow-contract-limits.test.mjs` |
| Workflow из обычной пользовательской фразы | `node --test tests/workflow-contract-natural.test.mjs` |
| Проверка собственного JSON без сохранения | `node contracts/workflow/validate.mjs /absolute/path/workflow.json` |
| Дополнительно проверить известные обязательные execution inputs | Та же команда с `--ready` |

Тесты контрактов проверяют **сохранённые ответы** агентов. Запуск тестов сам не вызывает LLM и не получает новый ответ. Для оценки изменённого контракта требуется отдельная независимая генерация ответа и её проверка. Один успешный ответ не доказывает устойчивость на любых формулировках.

Платный runner — `tests/live-workflow-scenarios.mjs`. Без аргументов он только печатает план. Его реальный запуск требует отдельного разрешения на конкретный прогон; обычные тесты его не запускают. Исторические расходы приведены ниже.

## Что именно отправлялось агентам

Полный вход состоит из сообщения агенту, указанных в нём файлов контракта и задания. Ниже сохранены исходные сообщения; инструкций о желаемом исходе проверки в них не добавлялось, однако подробность заданий существенно различалась.

| Серия | Сообщение агенту | Задание | Что проверяет |
|---|---|---|---|
| Готовые графы | [Точный текст](fixtures/workflow-contract/protocol/structured-agent-request.txt) | [Шесть JSON briefs](fixtures/workflow-contract/requests/) | Сборку уже заданных Steps/cards/references и сохранность решений |
| Лимиты | [Точный текст](fixtures/workflow-contract/protocol/boundary-agent-request.txt) | [Два briefs](fixtures/workflow-contract/boundary/requests/) | Применение ограничений к заранее заданным количествам/параметрам |
| Обычный язык | [Точный текст](fixtures/workflow-contract/protocol/natural-agent-request.txt) | [Фраза пользователя](fixtures/workflow-contract/natural/request.txt), [контекст приложения](fixtures/workflow-contract/natural/environment.json) | Самостоятельный перевод запроса в операции и последовательные зависимости |

**Ограничение прежних серий:** в первых шести briefs уже были `steps`, `cards`, `modelRole`, готовые `prompt`, `parameters` и `orderedImageReferences`. В граничных briefs были заранее заданы число Steps, правило ID, порядок и источники. Они не доказывали, что агент самостоятельно построит граф по обычной пользовательской фразе. Результаты этих серий относятся именно к сборке структурированных решений и проверке лимитов.

В последней серии задача передана дословно:

> дай мне workflow в котором генерируется изображение (промт 7 синих столбиков) потом оно 4 раз редактируется (промпт образно нечетные столбы в красный)

Контекст приложения содержал только три доступных model IDs и пустой список assets. В задании и сопровождающем сообщении не было числа карточек, числа Steps, ID, портов, готовых связей или ожидаемого ответа. К этому запуску инструкция контракта была уточнена общим правилом: пользователь может задавать задачу обычным языком, техническую структуру выбирает агент. Пример со столбиками в контракт не добавлялся; схема и валидатор не менялись. Прежние серии выполнялись до этого уточнения.

## Результат проверки обычного языка · 18 ноября 2026

Свежий агент `natural_consumer` прочитал только контракт, контекст приложения и фразу пользователя. Его [первичный ответ](fixtures/workflow-contract/natural/response.txt) сохранён без исправлений: **1 Step, 1 text-to-image, 4 image-edit**, четыре последовательные связи. Промпты сохранены как «7 синих столбиков» и «образно нечетные столбы в красный». В проверке не требовались конкретные имена/ID или выбранное агентом число Steps.

`node --test tests/workflow-contract-natural.test.mjs`: **1/1 прошёл с первого запуска**. Проверены контракт и локальный preflight, настоящий импорт в in-memory SQLite, editor round-trip и production runner с synthetic transport. Счётчик подтвердил один вызов генерации изображения и четыре редактирования; каждое редактирование получило output непосредственно предыдущего вызова. Цена/ответы имитировались, сеть и рабочая база не использовались. Проверка не подтверждает визуальную точность результата и не выполняет реальные image/video генерации. Прежние успешные тесты повторно не запускались.

## Карта структурированных сценариев

Описания ниже относятся к отдельным mocks, не входят в рабочий контракт и не задают пользователю формат запроса.

| Сценарий | Steps | Карточки | Предмет проверки |
|---|---:|---:|---|
| 01-stadium | 2 | 5 | Генерация + три edit → один 20-секундный video с четырьмя references |
| 02-mixed | 2 | 4 | Image/Video в каждом Step, связи внутри и между Steps |
| 03-slots | 2 | 3 | `n=2`, выбор output index 1, URL и порядок references |
| 04-local | 2 | 2 | Явный локальный файл для повторного выбора и URL |
| 05-flags | 3 | 3 | Disabled источник без истории и явно заданная пауза |
| 06-fanin | 3 | 6 | Четыре references из разных Steps с заданным порядком |

## Исторические результаты

Ниже перенесены записи прежних проверок. Это не новый общий прогон и не утверждение о текущих процессах, подключённых ключах или состоянии внешнего API.

## Библиотека и переносимый JSON

Проверено **56 сценариев**: прежние 46 и 2 новых UI-handler теста прошли полным прогоном; после исправления нового тестового fixture и совместимости Steps без названия выполнены целевые проверки 8 новых library-сценариев. Round-trip JSON проверен с пустыми слотами, настройками и URL; сохранность оригинала сравнивается с реально сохранённой JSON-записью. Проверены отсутствие внешних вызовов, импорт новой копией, локальные placeholders/preflight, неверные схемы, подтверждение удаления, защита активных/paused/recovering, сохранение assets/snapshots, удаление webhook inbox и поздняя доставка, localhost HTTP и сохранность после перезапуска. Это результаты полного и последующих целевых прогонов, не одного итогового запуска всей матрицы. Нового браузерного прохода и платных генераций не было.

## Контракт: структурированные задания и лимиты

Проверка по требованию пользователя выполнена независимым агентом `contract_consumer`: он прочитал только AGENTS, три документа контракта и шесть заданий с готовыми решениями. Код/валидатор/ожидаемые ответы ему не выдавались. Все шесть его первичных JSON оставлены без исправлений и прошли реальный HTTP import на изолированном сервере. [Mock briefs, ответы и описание проверки](fixtures/workflow-contract/README.md) хранятся отдельно. Сценарии: 4 images → один 20 s video; смешанные Image/Video Steps и телефон; batch outputIndex 1 + URL; local reattachment; disabled branch + pause; fan-in четырёх references из разных Steps с заданным порядком.

`tests/workflow-contract.test.mjs`: **10 новых проверок имеют успешный результат**. Первичный прогон — 9/10: проверка round-trip обнаружила потерю имени незаполненного локального файла существующим `editorToWorkflow`. Исправлена одна строка `public/graph.mjs`, теперь `{missing:true}` сохраняет доступный `name`. Повторены только затронутый local-сценарий и прежний portable-JSON тест — оба прошли. Дополнительно CLI `--ready` подтверждён для готового stadium (exit 0) и local reattachment (ожидаемый exit 1, importValid=true). Пять сценариев прошли production runner с synthetic transport; local-сценарий намеренно не запускался. Проверены prompts/settings/counts/flags/Step grouping, связи, editor round-trip, materialized refs, отсутствие повторных вызовов при pause/resume, отклонение некорректных схем и сохранение произвольных обычных API parameters. Новый полный прогон прежних 56 тестов не выполнялся.

Платных/внешних API вызовов, browser-проверки, импорта mocks в пользовательскую БД и перезапуска рабочего Studio не было. Runtime не менялся, кроме отдаваемого из файлов исправления frontend codec; актуальность подключённых ключей/webhook в этой работе не проверялась. Качество раскадровки, промптов и реальная поддержка параметров провайдерами не являются результатом этих тестов. Skills не написаны, внутренняя интеграция агента не реализована.

По следующему поручению Ильи добавлены **два слепых граничных задания**, без пояснений агенту сверх существующего контракта. Новый `boundary_consumer` получил неизменённые README/schema/registry и только briefs из `tests/fixtures/workflow-contract/boundary/requests/`; source, validator, ожидания и прежние ответы не выдавались. В первом задании агент вернул всю цепочку из **100 Steps / 100 карточек** (1 Image + 98 Edit + 1 Video), 99 зависимостей и вложенный mock-параметр с максимальной JSON traversal depth **64**. Реальный import в отдельную in-memory SQLite прошёл, параметры и структура сохранены. Во втором задании 65 карточек допустимы по количеству, но обязательная вложенность JSON **65**; агент вернул отказ с указанием конфликта, без изменения дерева или фиктивного workflow. Независимо собранный полный запрос отвергнут production importer до сохранения. Исходные ответы оставлены в `boundary/responses/*.txt` без правок.

`node --test tests/workflow-contract-limits.test.mjs`: **2/2 прошли с первого запуска**. Предыдущие успешные проверки не повторялись. Контракт, валидатор и код приложения в этом дополнении не менялись; HTTP, внешние API, генерации, пользовательская БД и сервис не затрагивались. Глубина дерева JSON проверяется отдельно от длины цепочки карточек. `scene_plan` — только mock для структурной проверки; поддержка этого параметра моделью не утверждается.

## Review-пауза и прежние браузерные проверки

Текущие 10 основных и 2 граничные проверки контракта, а также прежние 56 проверок библиотеки/JSON описаны выше с отдельными границами прогонов. Предыдущая поставка webhook прошла 46/46 offline-тестов; детали ниже. Следующие браузерные и 36-test результаты относятся к предыдущему исправлению паузы.

- **36/36 проверок прошли** одним прогоном `node --test tests/*.test.mjs` после исправления паузы. Прежний тест запрета изменения завершённого Step заменён проверкой свободного редактирования без неявной генерации. Все проверки используют offline transport; пакеты не устанавливались.
- Новый HTTP-сценарий: pause после Image 1 → изменение и отдельный Run Step, даже если Step выключен и следующий prompt ещё пуст → неудачная повторная попытка → оба успешных outputs сохранены → pin старого/нового → resume с точным новым input → сохранение исходной стоимости в carriedCost и истории → отдельный запуск Image 2 со старым выбранным output без генерации Image 1. Счётчик транспорта подтверждает ровно ожидаемые вызовы; проверяется stale parent revision.
- Новый UI-проход: prompt выполненного Step редактируется на паузе; «Запустить Step» создаёт новый output, основной run остаётся paused; переключение старого/нового output меняет preview; Continue передаёт новый output дальше без повтора первого Step; оба результата доступны, расходов исходного run $0.02 и отдельного Step $0.01 (fixture). Console errors нет. [Снимок паузы с кнопкой Step](../Handoff/evidence/18-pause-run-step.jpg). После правки новых реальных платных запросов не выполнялось.
- Новые unit-сценарии: кодирование enabled/view/reuse и управление Step; запрет неверной перестановки; layout DAG; четыре references с двумя reused источниками; необязательный/обязательный отсутствующий вход; pin, private/expired output; revision/live controls/pause/resume; перенумерация ссылок в prompt.
- Новый HTTP integration: prepare snapshot, запрет второго active run, revision conflict, выключение будущего Step, компактный polling, pause/resume без дублирования, persisted outputs и reused image → video. Счётчик транспорта подтвердил ровно один image и один video вызов.
- Изолированный UI-проход: Flow с двумя квадратами и стрелкой, разные фоны, перемещение вниз/вверх, удаление непустого Step и связи, запуск без ухода из редактора, два inline outputs на паузе и Continue до completed. После обнаруженного сброса итоговых меток в «из истории» UI исправлен: completed/reused сохраняются для совпадающего output; синтаксис и затронутое отображение повторно проверены. [Снимок](../Handoff/evidence/14-step-flow-offline.jpg).
- На реальном run verified reused outputs и новый расход $0. Мобильный размер 390×844: `scrollWidth=innerWidth=390`. [Снимок](../Handoff/evidence/15-step-reuse-mobile.jpg). Старые доказательства API editor, local file и двухэтапного acceptance сохраняются в [11](../Handoff/evidence/11-workflow-v2-mobile.jpg) и [13](../Handoff/evidence/13-workflow-v2-live.jpg).

## Webhook: offline-прогон

**46/46 тестов прошли** одним полным offline-прогоном `node --test tests/*.test.mjs`. Добавлены 10 сценариев: обе очередности webhook/polling, доставка до ответа POST, дубли, поздняя цена от незавершённого GET и отдельной сверки, неизменность output, Pause/ручной Step/reuse/архив стоимости, failed webhook, SQLite recovery после перезапуска, HMAC и изоляция endpoint, explicit callback/null, локальные HTTP настройки и legacy polling. Все прежние 36 тестов также прошли. Secret отсутствует в local state и проверенной SQLite. Проверен синтаксис модулей. Новый браузерный проход и внешняя доставка через Funnel не выполнялись; платных запросов — 0.

## Реальные пользовательские webhook-доставки

После подключения Илья спросил, какой канал определил готовность. 18 ноября read-only запросы к локальной SQLite показали два пользовательских `/v1/videos` задания: run `f187baee-646c-4b4c-b4e7-9303ab1f5a3e` завершён polling, подписанный `video.completed` принят на **2,271 с** позже `finishedAt`; предыдущий `370ce0e0-58e4-45af-b0e8-746163549b10` также завершён polling, webhook принят на **64,627 с** позже. Оба winner.source=`poll`, обе строки inbox существуют, статусы completed. Это подтверждает получение реальных подписанных уведомлений после пользовательских генераций, но не определяет причину их задержки. Сам агент новых генераций для диагностики не запускал, секреты не читал, код и сервис не менял. Источник уже сохраняется в `webhook_attempts.winner.source`; метки в UI пока нет.

## Проверка публичного доступа

18 ноября выполнена узкая read-only оценка публичного доступа по вопросу Ильи о безопасности. `tailscale funnel status` подтвердил единственный показанный публичный маршрут HTTPS → `127.0.0.1:8792`. Три HTTPS GET с этого Mac: `/health` = 200, `/` = 404, `/local/state` = 404. Это проверка через HTTPS-адрес с Mac, не внешний penetration test. По коду приёмник требует raw-body HMAC и сопоставление попытки/job, ограничивает body 2 MiB и время запроса; наружу не публикуются UI, assets или управление генерациями. Остаточные риски: отсутствует rate limiting, приёмник работает в одном Node-процессе со Studio (память/CPU и последствия возможной уязвимости общие), безопасность принятия результата зависит от сохранности webhook secret. Публичность Funnel допускает обращения любых интернет-клиентов; имя устройства в HTTPS-сертификате не является секретом. Полный аудит Mac, Tailscale ACL и нагрузочная проверка не проводились; код, конфигурация и процессы не менялись.

## Снимок сервиса после исправления паузы

Исторический запуск после исправления паузы: 18 ноября после проверки отсутствия активных заданий обновлены прежние разовые launchd jobs приложения. Server PID 49000, label `local.videorouterapiui.server.v2.1794949091`; proxy PID 49002, label `local.videorouterapiui.tailscale.v2.1794949091`. Это снимок после исправления паузы. Отдельная команда подтвердила HTTP 200 localhost и Tailscale, подключение обоих ключей в памяти, сохранность всех 120 runs и всех трёх paused runs, выполняющихся запросов 0. Пользовательские паузы не продолжались и не пересоздавались. Изолированный offline server остановлен, основной server + proxy оставлены работающими.

## Снимок сервиса после webhook-поставки

Исторический запуск после webhook-поставки: 18 ноября проверено отсутствие активных генераций, затем перезапущен только существующий server job через `launchctl kickstart -k` с сохранением его окружения. Server PID **59790**, прежний label; proxy PID **49002** не перезапускался. `data/launcher.pid` обновлён в полном формате `59790 8791`. Проверены localhost и Tailscale, отдача нового app.js, сохранность точного набора **127 runs** и тех же **трёх paused runs**, running=0. Webhook settings были enabled=false/ready=false до последующего подключения Ильёй.

## Снимок сервиса после библиотеки/JSON

Текущее состояние после поставки библиотеки/JSON: при running=0 перезапущен только тот же server launchd job, новый PID **69730**; proxy **49002** не менялся. Сохранены точные IDs **129 runs**, **3 paused runs** и полное содержимое **9 workflows**. Read-only `/local/workflow/export` проверен на пустой синтетической схеме; новый `/workflow-json.mjs` доступен через Tailscale. Пользовательские данные не удалялись, тестовые workflows в рабочую базу не импортировались. PID-файл записан полностью: `69730 8791`. Webhook ready=false после потери секрета в памяти при перезапуске; пользователь заранее предупреждён, требуется повторное подключение секрета через UI. Polling сохраняется, Funnel не перенастраивался. Сервис оставлен работающим.

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

Машиночитаемые факты: [12-workflow-v2-live.json](../Handoff/evidence/12-workflow-v2-live.json). Итоговый экран после исправления подписей: [13-workflow-v2-live.jpg](../Handoff/evidence/13-workflow-v2-live.jpg). Ссылка на видео хранится в run и JSON evidence; она может истечь. Изолированный offline server остановлен, основной server + proxy оставлены работающими.

Источники контрактов: [API overview](https://videorouter.sh/docs/api-reference), [Images](https://videorouter.sh/docs/api-reference-images), [Image edit](https://videorouter.sh/docs/image-edit), [Video](https://videorouter.sh/docs/api-reference-video). Документация и бесплатные pricing endpoints использовались для подготовки запросов; окончательная проверка — фактический run.

## Пять реальных сценариев 18 ноября: active / reused Steps

Эта платная серия относится к версии `f4438cc`, до последующего исправления review-паузы и добавления «Запустить Step». Новое поведение проверено 36 offline-тестами и отдельным браузерным проходом; платная серия повторно не запускалась.

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

Доказательства: [JSON пяти сценариев](../Handoff/evidence/17-step-live-scenarios.json), [финальный Flow и видео](../Handoff/evidence/16-step-four-reference-video.jpg), [мобильный reused Step](../Handoff/evidence/15-step-reuse-mobile.jpg). API keys, raw requests и медиафайлы в Git не добавлялись. Полная платная матрица всех моделей не выполнялась.
