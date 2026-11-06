# Мини-CRM «Объекты и задачи»

Постановщики ведут объекты (стройки) и задачи. Исполнители берут задачи в работу и сдают на проверку. Все правила доступа и цикл статусов проверяет база данных (Supabase: PostgreSQL + RLS), а не только интерфейс.

**Стек:** React 19, TypeScript, Vite, Supabase (Auth, PostgreSQL, RLS), Pico.css.

- [docs/DECISIONS.md](docs/DECISIONS.md) — решения, допущения, ограничения и устройство защиты.
- [docs/FOR_MANAGER.md](docs/FOR_MANAGER.md) — объяснение для руководителя.

## Структура

```
supabase/migrations/   SQL-миграция: таблицы, права, RLS, триггеры, функции
scripts/seed.mjs       создание демо-пользователей, ролей и демо-данных
tests/access.test.mjs  проверки доступа прямыми запросами под пользовательскими сессиями
src/                   фронтенд (lib.ts — клиент и общие хелперы, auth.tsx, pages/)
```

## Требования

- Node.js 22 или новее (`.nvmrc`). Скрипту и тестам нужен встроенный WebSocket.
- Проект Supabase: облачный бесплатный тариф или локальный (`npx supabase start`, нужен Docker).

## 1. Настройка Supabase (облако)

1. Создайте проект на supabase.com.
2. **Отключите регистрацию:** Authentication → Sign In / Providers → снимите флажок *Allow new users to sign up*. Провайдер Email оставьте включённым, иначе не будет входа по паролю.
3. **Примените миграцию** одним из способов:
   - SQL Editor → вставьте содержимое `supabase/migrations/20261106000000_init.sql` → Run;
   - или через CLI: `npx supabase login`, `npx supabase link --project-ref <ref>`, `npx supabase db push`.
4. Project Settings → API Keys: скопируйте Project URL, публичный ключ (anon / publishable) и секретный ключ (service_role / secret).

## 2. Переменные окружения

```bash
cp .env.example .env.local
```

| Переменная | Где используется | Секрет? |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | фронтенд, скрипт, тесты | нет: публичные, доступ ограничен RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | только `scripts/seed.mjs` | **да** |
| `DEMO_PASSWORD` | пароль демо-пользователей: скрипт и тесты | **да** |

Файл `.env.local` в `.gitignore`. Vite включает в сборку только переменные с префиксом `VITE_`, поэтому service role в бандл не попадает.

## 3. Пользователи и демо-данные

```bash
npm install
npm run seed
```

Скрипт идемпотентный. Он создаёт четырёх пользователей с паролем `DEMO_PASSWORD`:

| Email | Имя | Роль |
|---|---|---|
| manager1@example.com | Анна Смирнова | постановщик |
| manager2@example.com | Олег Кузнецов | постановщик |
| executor1@example.com | Иван Петров | исполнитель |
| executor2@example.com | Сергей Волков | исполнитель |

Затем от имени этих пользователей, через обычный API, скрипт создаёт 3 объекта и 6 задач во всех статусах. Все статусы получены только допустимыми переходами.

**Создать пользователя вручную:** Authentication → Users → Add user → Create new user (Auto Confirm). Затем в SQL Editor:

```sql
insert into public.profiles (id, full_name, role)
values ('<uuid пользователя>', 'Имя Фамилия', 'executor');  -- или 'manager'
```

Роль хранится только в таблице `profiles`. Писать в неё может только администратор (SQL Editor или service role), пользователь изменить её не может.

## 4. Запуск

```bash
npm run dev       # http://localhost:5173
npm run build     # проверка TypeScript и сборка в dist/
npm run lint
```

## 5. Проверки доступа к базе

```bash
npm run test:db
```

11 сценариев (`node:test`). Тесты входят под демо-пользователями с публичным ключом и шлют запросы напрямую в Supabase, в обход интерфейса. Service role в тестах не используется. Тесты создают свои объекты и задачи, а в конце мягко удаляют их.

Локально, без облака:

```bash
npx supabase start
```

Затем возьмите URL и ключи из `npx supabase status` в `.env.local` и выполните `npm run seed` и `npm run test:db`.

## 6. Публикация

Сборка статическая. Маршруты на `HashRouter`, `base: './'`, поэтому подходит любой хостинг без настройки rewrites.

- **Vercel / Netlify:** импортируйте репозиторий. Build command: `npm run build`, output: `dist`. В Environment Variables задайте **только** `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`.
- **Вручную:** `npm run build`, затем загрузите `dist/` на любой статический хостинг.
