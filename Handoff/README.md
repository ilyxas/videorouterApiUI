# VideoRouter API Studio — точка входа

Проект: `/Users/ilya/Development/Challange/videorouterApiUI`.

## Карта документации

| Что нужно | Где читать |
|---|---|
| Запуск, подключение и использование | [README проекта](../README.md) |
| Актуальная архитектура и состояние реализации | [10 — Workflow v2](10-workflow-v2.md) |
| Контракт построения workflow JSON для агента | [Контракт](../contracts/workflow/README.md) |
| Описание тестов, точные запросы агентам и результаты прогонов | [Тесты и результаты](../tests/TESTING.md) |
| Исходные задания и ответы тестовых агентов | [Карта fixtures](../tests/fixtures/workflow-contract/README.md) |
| Историческое состояние до Workflow v2 | [09 — прежний handoff](09-current-state-and-next-thread.md) |
| Исторические решения по оценке стоимости | [08 — оценка, модели и формат](08-quote-model-format-fix.md) |

Начинать работу с документа 10 и актуального кода. Документы 01–09 — история; содержащиеся в них старые планы не являются новыми поручениями.

## Состояние реализации

Studio includes a local Grok CLI provider for image generation/editing and text/image/reference video, alongside VideoRouter. Studio supports Step DAGs, pause editing, standalone Step execution, output reuse, estimates, webhook plus polling, history management, and JSON import/export. CharacterCards and LocationCards add separate reusable identity/place metadata and local assets as workflow-level snapshots; Workflow Flow shows the complete graph. See document 10 for activation status and limitations.

The agent contract accepts an ordinary-language task and describes import-ready JSON. The user need not supply a graph. The shared `vrapiwf-director` skill provides scene planning and prompts; an embedded AI assistant is not implemented.

## Поддержание документации

Правило актуальности — в [AGENTS.md](../AGENTS.md). Описание реализации обновляется в документе 10, результаты проверок — в документе тестов. Этот README остаётся картой: журналы прогонов, расходы и снимки runtime сюда не добавляются. Ради чтения или обновления документации сервис не перезапускается.
