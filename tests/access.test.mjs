// Проверки доступа прямыми запросами к Supabase с сессиями реальных пользователей.
// service_role здесь НЕ используется (он обходит RLS) — только anon-ключ + вход по паролю.
// Нужны демо-пользователи из scripts/seed.mjs.
// Запуск: npm run test:db
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createClient } from '@supabase/supabase-js'

const url = process.env.VITE_SUPABASE_URL
const anonKey = process.env.VITE_SUPABASE_ANON_KEY
const password = process.env.DEMO_PASSWORD
const opts = { auth: { persistSession: false, autoRefreshToken: false } }
const STATUSES = ['new', 'in_progress', 'review', 'accepted', 'rework']
// Таблица из ТЗ: переход → кто может (executor = назначенный исполнитель)
const TRANSITIONS = {
  'new>in_progress': 'executor',
  'in_progress>review': 'executor',
  'review>accepted': 'manager',
  'review>rework': 'manager',
  'rework>in_progress': 'executor',
}

async function signIn(email) {
  const c = createClient(url, anonKey, opts)
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`${email}: ${error.message}`)
  c.uid = data.user.id
  c.email = email
  return c
}

const ok = ({ data, error }) => {
  assert.equal(error, null, error?.message)
  return data
}
const fails = ({ error }, re) => {
  assert.ok(error, 'ожидалась ошибка')
  if (re) assert.match(error.message, re)
}

const anon = createClient(url, anonKey, opts)
let m1, m2, e1, e2
let shared, onlyE2, tA, tB

const newTask = async (by, object_id, assignee, title = 'Тест') =>
  ok(await by.from('tasks').insert({ object_id, title, assignee_id: assignee.uid }).select().single())
const history = async (taskId) => ok(await m1.from('task_status_history').select('*').eq('task_id', taskId).order('id'))
const statusOf = async (taskId) => ok(await m1.from('tasks').select('status').eq('id', taskId).single()).status
const move = (by, id, to, comment) => by.rpc('change_task_status', { p_task_id: id, p_new_status: to, p_comment: comment })

before(async () => {
  ;[m1, m2, e1, e2] = await Promise.all(
    ['manager1', 'manager2', 'executor1', 'executor2'].map((n) => signIn(`${n}@example.com`)),
  )
  const stamp = new Date().toISOString()
  shared = ok(await m1.from('objects').insert({ name: `ТЕСТ общий ${stamp}`, address: 'тест' }).select().single())
  onlyE2 = ok(await m1.from('objects').insert({ name: `ТЕСТ только e2 ${stamp}`, address: 'тест' }).select().single())
  tA = await newTask(m1, shared.id, e1, 'Задача A (e1)')
  tB = await newTask(m1, shared.id, e2, 'Задача B (e2)')
  await newTask(m1, onlyE2.id, e2, 'Задача C (e2)')
})

after(async () => {
  for (const o of [shared, onlyE2]) if (o) await m1.rpc('delete_object', { p_object_id: o.id })
})

test('анонимный пользователь не получает данные и не вызывает функции', async () => {
  for (const t of ['profiles', 'objects', 'tasks', 'task_status_history']) {
    const { data, error } = await anon.from(t).select('*')
    assert.ok(error || data.length === 0, `anon прочитал ${t}`)
  }
  fails(await move(anon, tA.id, 'in_progress'))
  fails(await anon.from('objects').insert({ name: 'x', address: 'y' }))
})

test('открытая регистрация отключена', async () => {
  const { data, error } = await anon.auth.signUp({ email: `hacker${Date.now()}@example.com`, password: 'Passw0rd!123' })
  assert.ok(error, 'signUp должен быть запрещён')
  assert.equal(data.user, null)
})

test('исполнитель A не читает задачи, историю и объекты исполнителя B, даже зная ID', async () => {
  assert.equal(ok(await e1.from('tasks').select('*').eq('id', tB.id).maybeSingle()), null)
  assert.deepEqual(ok(await e1.from('task_status_history').select('*').eq('task_id', tB.id)), [])
  assert.equal(ok(await e1.from('objects').select('*').eq('id', onlyE2.id).maybeSingle()), null)
  // в общем объекте видит объект, но только свою задачу
  assert.ok(ok(await e1.from('objects').select('*').eq('id', shared.id).maybeSingle()))
  const visible = ok(await e1.from('tasks').select('id').eq('object_id', shared.id)).map((t) => t.id)
  assert.deepEqual(visible, [tA.id])
  // в общем списке задач — только свои
  const all = ok(await e1.from('tasks').select('assignee_id'))
  assert.ok(all.every((t) => t.assignee_id === e1.uid))
})

test('исполнитель A не меняет задачу исполнителя B', async () => {
  ok(await e1.from('tasks').update({ title: 'взлом' }).eq('id', tB.id))
  assert.equal(ok(await m1.from('tasks').select('title').eq('id', tB.id).single()).title, 'Задача B (e2)')
  fails(await move(e1, tB.id, 'in_progress'), /не найдена/)
  assert.equal(await statusOf(tB.id), 'new')
})

test('исполнитель не меняет реквизиты своей задачи, автора, статус напрямую и свою роль', async () => {
  // Колонки без права на запись — ошибка прав
  fails(await e1.from('tasks').update({ author_id: e1.uid }).eq('id', tA.id), /permission denied/)
  fails(await e1.from('tasks').update({ status: 'accepted' }).eq('id', tA.id), /permission denied/)
  // Реквизиты — RLS не даёт ни одной строки на обновление
  for (const patch of [{ title: 'x' }, { description: 'x' }, { assignee_id: e2.uid }, { object_id: onlyE2.id }]) {
    ok(await e1.from('tasks').update(patch).eq('id', tA.id))
  }
  const row = ok(await m1.from('tasks').select('*').eq('id', tA.id).single())
  assert.equal(row.title, 'Задача A (e1)')
  assert.equal(row.description, '')
  assert.equal(row.assignee_id, e1.uid)
  assert.equal(row.object_id, shared.id)
  assert.equal(row.author_id, m1.uid)
  // Роль
  fails(await e1.from('profiles').update({ role: 'manager' }).eq('id', e1.uid), /permission denied/)
  fails(await e1.from('profiles').insert({ id: e1.uid, full_name: 'x', role: 'manager' }), /permission denied/)
  // Метаданные пользователя ролью не являются
  ok(await e1.auth.updateUser({ data: { role: 'manager' } }))
  assert.equal(ok(await e1.from('tasks').select('*').eq('id', tB.id).maybeSingle()), null)
  ok(await e1.auth.updateUser({ data: { role: null } }))
  fails(await e1.rpc('delete_task', { p_task_id: tA.id }), /Недостаточно прав/)
  fails(await e1.from('objects').insert({ name: 'x', address: 'y' }))
})

test('автор и время создания задаются базой; исполнитель — только с ролью «Исполнитель»', async () => {
  fails(
    await m1.from('tasks').insert({ object_id: shared.id, title: 'x', assignee_id: e1.uid, author_id: m2.uid }),
    /permission denied/,
  )
  fails(
    await m1.from('tasks').insert({ object_id: shared.id, title: 'x', assignee_id: e1.uid, created_at: '2000-01-01' }),
    /permission denied/,
  )
  fails(await m1.from('tasks').insert({ object_id: shared.id, title: 'x', assignee_id: m2.uid }), /Исполнитель/)
  fails(await m1.from('tasks').insert({ object_id: shared.id, title: 'x', assignee_id: e1.uid, status: 'accepted' }), /permission denied/)
})

test('полный цикл: проходят только переходы из ТЗ и только у своей роли, каждый пишет одну запись истории', async () => {
  const t = await newTask(m1, shared.id, e1, 'Цикл')
  let h = await history(t.id)
  assert.equal(h.length, 1)
  assert.deepEqual([h[0].from_status, h[0].to_status, h[0].actor_id], [null, 'new', m1.uid])

  // [кто, куда, комментарий]
  const path = [
    [e1, 'in_progress'],
    [e1, 'review'],
    [m2, 'rework', '  Переделать  '], // второй постановщик тоже может
    [e1, 'in_progress'],
    [e1, 'review'],
    [m1, 'accepted'],
  ]
  for (const [actor, to, comment] of [...path, [null, null]]) {
    const from = await statusOf(t.id)
    const before = (await history(t.id)).length
    // Все остальные комбинации (роль × целевой статус) запрещены
    for (const c of [m1, m2, e1, e2]) {
      for (const s of STATUSES) {
        // Разрешённые по ТЗ переходы не пробуем (они изменили бы статус)
        const who = TRANSITIONS[`${from}>${s}`]
        if ((who === 'manager' && (c === m1 || c === m2)) || (who === 'executor' && c === e1)) continue
        const r = await move(c, t.id, s, 'комментарий')
        assert.ok(r.error, `${from} → ${s} не должен пройти для ${c.email}`)
      }
    }
    fails(await m1.from('tasks').update({ status: to ?? 'new' }).eq('id', t.id), /permission denied/)
    assert.equal(await statusOf(t.id), from, 'запрещённые попытки не изменили статус')
    assert.equal((await history(t.id)).length, before, 'запрещённые попытки не писали историю')
    if (!actor) break

    if (to === 'rework') {
      fails(await move(actor, t.id, 'rework'), /комментарий/)
      fails(await move(actor, t.id, 'rework', '   \n\t '), /комментарий/)
    }
    ok(await move(actor, t.id, to, comment))
    h = await history(t.id)
    assert.equal(h.length, before + 1)
    const last = h.at(-1)
    assert.deepEqual(
      [last.from_status, last.to_status, last.actor_id, last.comment],
      [from, to, actor.uid, comment ? comment.trim() : null],
    )
  }
  assert.equal(await statusOf(t.id), 'accepted')
})

test('историю нельзя вставить, изменить или удалить напрямую', async () => {
  const before = await history(tA.id)
  for (const c of [m1, e1]) {
    fails(
      await c.from('task_status_history').insert({ task_id: tA.id, actor_id: c.uid, from_status: 'new', to_status: 'in_progress' }),
      /permission denied/,
    )
    fails(await c.from('task_status_history').update({ comment: 'подделка' }).eq('task_id', tA.id), /permission denied/)
    fails(await c.from('task_status_history').delete().eq('task_id', tA.id), /permission denied/)
  }
  assert.deepEqual(await history(tA.id), before)
})

test('параллельные смены статуса: проходит ровно одна', async () => {
  const t = await newTask(m1, shared.id, e1, 'Гонка')
  const results = await Promise.all(Array.from({ length: 8 }, () => move(e1, t.id, 'in_progress')))
  assert.equal(results.filter((r) => !r.error).length, 1)
  assert.equal((await history(t.id)).filter((h) => h.to_status === 'in_progress').length, 1)

  ok(await move(e1, t.id, 'review'))
  const race = await Promise.all([move(m1, t.id, 'accepted'), move(m2, t.id, 'rework', 'нет')])
  assert.equal(race.filter((r) => !r.error).length, 1, 'принять и вернуть одновременно нельзя')
  assert.equal((await history(t.id)).length, 4)
})

test('несколько постановщиков: второй видит и меняет задачи первого', async () => {
  const seen = ok(await m2.from('tasks').select('id').in('id', [tA.id, tB.id]))
  assert.equal(seen.length, 2)
  ok(await m2.from('objects').update({ address: 'новый адрес' }).eq('id', shared.id))
  const upd = ok(await m2.from('tasks').update({ description: 'уточнено' }).eq('id', tB.id).select())
  assert.equal(upd.length, 1)
  // переназначение: история становится видна новому исполнителю и скрывается от прежнего
  ok(await m2.from('tasks').update({ assignee_id: e1.uid }).eq('id', tB.id))
  assert.ok((await e1.from('task_status_history').select('id').eq('task_id', tB.id)).data.length > 0)
  assert.deepEqual(ok(await e2.from('task_status_history').select('id').eq('task_id', tB.id)), [])
  assert.equal(ok(await e2.from('tasks').select('id').eq('id', tB.id).maybeSingle()), null)
})

test('удаление мягкое: запись скрывается, история остаётся, физическое удаление запрещено', async () => {
  const t = await newTask(m1, shared.id, e1, 'Удаляемая')
  fails(await m1.from('tasks').delete().eq('id', t.id), /permission denied/)
  fails(await m1.from('objects').delete().eq('id', shared.id), /permission denied/)
  ok(await m2.rpc('delete_task', { p_task_id: t.id }))
  assert.equal(ok(await m1.from('tasks').select('id').eq('id', t.id).maybeSingle()), null)
  assert.deepEqual(ok(await e1.from('task_status_history').select('id').eq('task_id', t.id)), [])
  fails(await move(e1, t.id, 'in_progress'), /не найдена/)
})
