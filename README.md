# Mnemo

Карточки для запоминания с интервальными повторениями — бесплатное приложение для iPhone (PWA), похожее на Anki.

- **Алгоритм FSRS-6** (как в современной Anki): интервалы подбираются под желаемое удержание.
- **Совместимость с Anki**: импорт колод `.apkg` / `.colpkg` с медиа, шаблонами, пропусками и прогрессом.
- **Работает офлайн**, данные хранятся только на устройстве (IndexedDB); резервная копия — одним нажатием.
- Пропуски (cloze), ввод ответа, обратные карточки, изображения, звук, озвучка (TTS), метки, флаги, поиск в стиле Anki, статистика, тёмная тема.

## Установка на iPhone

1. Откройте сайт приложения в Safari.
2. «Поделиться» → «На экран „Домой“» → «Добавить».

Подписка Apple и переустановка не нужны: это веб-приложение.

## Нативное приложение для iPhone (бесплатный Apple ID)

Тот же код упакован в iOS-приложение (Capacitor, папка `ios/`). С бесплатным Apple ID подпись действует 7 дней, поэтому Mac продлевает её сам:

- раз в 3 часа проверяет срок и за 2 дня до окончания пересобирает и переустанавливает приложение поверх старого — данные внутри приложения сохраняются;
- перед каждой переустановкой забирает с iPhone автокопии (`Файлы → На iPhone → Mnemo → Backups`) в `~/Documents/Mnemo Backups`;
- берёт свежую версию кода из GitHub и шлёт уведомление на Mac, если iPhone недоступен.

Подготовка (один раз): Xcode → Settings → Accounts → добавить Apple ID; подключить iPhone кабелем, «Доверять», включить «Режим разработчика»; в Xcode → Window → Devices and Simulators отметить «Connect via network».

Включить автопродление:

```bash
git clone https://github.com/Oleksandr-Kliuiev/mnemo.git "$HOME/Library/Application Support/Mnemo/repo"
bash "$HOME/Library/Application Support/Mnemo/repo/ios/scripts/setup-automation.sh"
```

Первая установка (iPhone подключён и разблокирован):

```bash
bash "$HOME/Library/Application Support/Mnemo/repo/ios/scripts/mnemo-ios.sh" install
```

После неё на iPhone один раз: Настройки → Основные → VPN и управление устройством → ваш Apple ID → «Доверять».
Статус: `mnemo-ios.sh status`, выключить: `ios/scripts/remove-automation.sh`.

## Разработка

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # unit-тесты (Vitest)
npm run build     # проверка типов и сборка в dist/
npm run icons     # перегенерировать иконки и заставки
```

Публикация: каждый push в `main` собирается и выкладывается на GitHub Pages (`.github/workflows/deploy.yml`).

## Устройство

- `src/sched` — FSRS (ts-fsrs), учебные дни, очереди и лимиты сессии.
- `src/render` — движок шаблонов Anki, пропуски, сравнение введённого ответа, очистка HTML.
- `src/import` — импорт `.apkg`/`.colpkg`, CSV/TXT, резервные копии.
- `src/db` — схема Dexie, операции с колодами, записями и карточками.
- `src/screens`, `src/ui` — интерфейс (React).
