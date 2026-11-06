// Административный скрипт: создаёт демо-пользователей, роли и демо-данные.
// Запуск: node --env-file=.env.local scripts/seed.mjs
//
// service_role используется ТОЛЬКО для создания учётных записей и строк profiles
// (это и есть «административный путь вне фронтенда»). Объекты, задачи и смены статусов
// выполняются от имени самих пользователей через обычный API — те же RLS и проверки,
// что и у интерфейса, поэтому демо-статусы получены только допустимыми переходами.
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const anonKey = process.env.VITE_SUPABASE_ANON_KEY
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const password = process.env.DEMO_PASSWORD
if (!url || !anonKey || !serviceKey || !password) {
  console.error('Нужны VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DEMO_PASSWORD')
  process.exit(1)
}

const DEMO_USERS = [
  { email: 'manager1@example.com', full_name: 'Анна Смирнова', role: 'manager' },
  { email: 'manager2@example.com', full_name: 'Олег Кузнецов', role: 'manager' },
  { email: 'executor1@example.com', full_name: 'Иван Петров', role: 'executor' },
  { email: 'executor2@example.com', full_name: 'Сергей Волков', role: 'executor' },
]

const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(url, serviceKey, opts)

const must = ({ data, error }) => {
  if (error) throw new Error(error.message)
  return data
}

// 1. Пользователи и роли (идемпотентно).
const { users: existing } = must(await admin.auth.admin.listUsers({ perPage: 1000 }))
const ids = {}
for (const u of DEMO_USERS) {
  let user = existing.find((e) => e.email === u.email)
  if (!user) {
    user = must(await admin.auth.admin.createUser({ email: u.email, password, email_confirm: true })).user
    console.log('создан пользователь', u.email)
  }
  ids[u.email] = user.id
  must(await admin.from('profiles').upsert({ id: user.id, full_name: u.full_name, role: u.role }))
}

// 2. Демо-данные — от имени пользователей.
async function signIn(email) {
  const client = createClient(url, anonKey, opts)
  must(await client.auth.signInWithPassword({ email, password }))
  return client
}

const m1 = await signIn('manager1@example.com')
const m2 = await signIn('manager2@example.com')
const e1 = await signIn('executor1@example.com')
const e2 = await signIn('executor2@example.com')

const { count } = await m1.from('objects').select('*', { count: 'exact', head: true })
if (count > 0) {
  console.log('Демо-данные уже есть, пропускаю.')
  process.exit(0)
}

const obj = async (name, address) => must(await m1.from('objects').insert({ name, address }).select().single()).id
const north = await obj('ЖК «Северный», корпус 2', 'г. Москва, ул. Северная, 12')
const cottage = await obj('Коттедж Ивановых', 'Московская обл., п. Лесной, ул. Сосновая, 7')
const warehouse = await obj('Склад «Логистик»', 'г. Химки, Промышленный пр-д, 3')

const task = async (by, object_id, title, description, assignee) =>
  must(
    await by
      .from('tasks')
      .insert({ object_id, title, description, assignee_id: ids[assignee] })
      .select()
      .single(),
  ).id
const move = async (by, id, status, comment) =>
  must(await by.rpc('change_task_status', { p_task_id: id, p_new_status: status, p_comment: comment }))

// Принята: полный цикл.
const t1 = await task(m1, north, 'Залить фундамент', 'Бетон М300, проверить армирование.', 'executor1@example.com')
await move(e1, t1, 'in_progress')
await move(e1, t1, 'review')
await move(m1, t1, 'accepted')

// В работе после возврата на доработку (принимает второй постановщик).
const t2 = await task(m1, north, 'Монтаж опалубки 2 этажа', 'По проекту КЖ-2.', 'executor1@example.com')
await move(e1, t2, 'in_progress')
await move(e1, t2, 'review')
await move(m2, t2, 'rework', 'Опалубка не выставлена по уровню, переделать участок у оси 3.')
await move(e1, t2, 'in_progress')

// Новая.
await task(m2, north, 'Вывоз строительного мусора', 'Заказать контейнер 20 м³.', 'executor2@example.com')

// На проверке.
const t4 = await task(m1, cottage, 'Кровельные работы', 'Металлочерепица, цвет RAL 3005.', 'executor2@example.com')
await move(e2, t4, 'in_progress')
await move(e2, t4, 'review')

// На доработке.
const t5 = await task(m2, cottage, 'Разводка электрики', 'Первый этаж, по схеме ЭМ-1.', 'executor2@example.com')
await move(e2, t5, 'in_progress')
await move(e2, t5, 'review')
await move(m2, t5, 'rework', 'Нет фотоотчёта по щиту, приложите и отправьте снова.')

// В работе.
const t6 = await task(m1, warehouse, 'Устройство промышленных полов', 'Топпинг, площадь 1200 м².', 'executor1@example.com')
await move(e1, t6, 'in_progress')

console.log('Демо-данные созданы.')
