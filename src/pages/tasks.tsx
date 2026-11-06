import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { ACTIONS, STATUS_LABEL, errorText, fmtDate, must, supabase, useLoad, type Named, type Status } from '../lib'
import { Loader, StatusBadge } from './ui'

type TaskFull = {
  id: string
  title: string
  description: string
  status: Status
  created_at: string
  assignee_id: string
  object_id: string
  object: { name: string } | null
  assignee: Named
  author: Named
}
type HistoryRow = {
  id: number
  created_at: string
  from_status: Status | null
  to_status: Status
  comment: string | null
  actor: Named
}

const TASK_SELECT =
  'id, title, description, status, created_at, assignee_id, object_id, object:objects(name), ' +
  'assignee:profiles!tasks_assignee_id_fkey(full_name), author:profiles!tasks_author_id_fkey(full_name)'

export function TaskCard() {
  const { id } = useParams() as { id: string }
  const { me } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [commentFor, setCommentFor] = useState<Status>()

  const res = useLoad(async () => {
    const task = must(await supabase.from('tasks').select(TASK_SELECT).eq('id', id).maybeSingle()) as unknown as TaskFull | null
    if (!task) return null
    const history = must(
      await supabase
        .from('task_status_history')
        .select('id, created_at, from_status, to_status, comment, actor:profiles(full_name)')
        .eq('task_id', id)
        .order('id'),
    ) as unknown as HistoryRow[]
    return { task, history }
  }, [id])

  async function changeStatus(to: Status, comment?: string) {
    if (busy) return
    setBusy(true)
    setError(undefined)
    const { error } = await supabase.rpc('change_task_status', { p_task_id: id, p_new_status: to, p_comment: comment ?? null })
    setBusy(false)
    if (error) setError(errorText(error))
    else setCommentFor(undefined)
    res.reload() // и после ошибки: статус мог изменить кто-то другой
  }

  function submitComment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const comment = String(new FormData(e.currentTarget).get('comment')).trim()
    if (!comment) return setError('Комментарий обязателен')
    void changeStatus(commentFor!, comment)
  }

  async function remove(objectId: string) {
    if (!confirm('Удалить задачу? История сохранится в базе.')) return
    setBusy(true)
    const { error } = await supabase.rpc('delete_task', { p_task_id: id })
    setBusy(false)
    if (error) setError(errorText(error))
    else navigate(`/objects/${objectId}`)
  }

  return (
    <Loader res={res} empty={(d) => !d && 'Задача не найдена или у вас нет к ней доступа.'}>
      {(d) => {
        if (!d || !me) return null
        const t = d.task
        const actions = ACTIONS.filter(
          (a) => a.from === t.status && a.role === me.role && (a.role === 'manager' || t.assignee_id === me.id),
        )
        return (
          <>
            <p>
              <Link to={`/objects/${t.object_id}`}>← {t.object?.name ?? 'Объект'}</Link>
            </p>
            <div className="row">
              <h2>{t.title}</h2>
              {me.role === 'manager' && (
                <div className="actions">
                  <Link role="button" className="secondary outline" to={`/tasks/${id}/edit`}>
                    Редактировать
                  </Link>
                  <button className="secondary" disabled={busy} onClick={() => remove(t.object_id)}>
                    Удалить
                  </button>
                </div>
              )}
            </div>
            <dl className="fields">
              <dt>Статус</dt>
              <dd>
                <StatusBadge status={t.status} />
              </dd>
              <dt>Объект</dt>
              <dd>{t.object?.name ?? '—'}</dd>
              <dt>Исполнитель</dt>
              <dd>{t.assignee?.full_name ?? '—'}</dd>
              <dt>Автор</dt>
              <dd>{t.author?.full_name ?? '—'}</dd>
              <dt>Создана</dt>
              <dd>{fmtDate(t.created_at)}</dd>
              <dt>Описание</dt>
              <dd className="pre">{t.description || '—'}</dd>
            </dl>

            {error && <p className="error">{error}</p>}
            {commentFor ? (
              <form onSubmit={submitComment}>
                <label>
                  Комментарий — что нужно исправить
                  <textarea name="comment" required rows={3} autoFocus />
                </label>
                <div className="actions">
                  <button type="submit" disabled={busy} aria-busy={busy}>
                    Вернуть на доработку
                  </button>
                  <button type="button" className="secondary outline" onClick={() => setCommentFor(undefined)}>
                    Отмена
                  </button>
                </div>
              </form>
            ) : (
              actions.length > 0 && (
                <div className="actions">
                  {actions.map((a) => (
                    <button
                      key={a.to}
                      className={a.needsComment ? 'secondary' : undefined}
                      disabled={busy}
                      aria-busy={busy}
                      onClick={() => (a.needsComment ? setCommentFor(a.to) : changeStatus(a.to))}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )
            )}

            <h3>История</h3>
            <table>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Кто</th>
                  <th>Изменение</th>
                  <th>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {d.history.map((h) => (
                  <tr key={h.id}>
                    <td>{fmtDate(h.created_at)}</td>
                    <td>{h.actor?.full_name ?? '—'}</td>
                    <td>
                      {h.from_status ? `${STATUS_LABEL[h.from_status]} → ` : 'Создана → '}
                      {STATUS_LABEL[h.to_status]}
                    </td>
                    <td className="pre">{h.comment ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )
      }}
    </Loader>
  )
}

export function TaskForm() {
  const { id, objectId } = useParams() // id — редактирование, objectId — создание
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const res = useLoad(async () => {
    const [executors, objects, task] = await Promise.all([
      supabase.from('profiles').select('id, full_name').eq('role', 'executor').order('full_name').then(must),
      supabase.from('objects').select('id, name').order('name').then(must),
      id
        ? supabase.from('tasks').select('title, description, object_id, assignee_id').eq('id', id).maybeSingle().then(must)
        : { title: '', description: '', object_id: objectId ?? '', assignee_id: '' },
    ])
    return task && { executors, objects, task }
  }, [id, objectId])

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    const f = new FormData(e.currentTarget)
    const values = {
      title: String(f.get('title')).trim(),
      description: String(f.get('description')).trim(),
      object_id: String(f.get('object_id')),
      assignee_id: String(f.get('assignee_id')),
    }
    setBusy(true)
    setError(undefined)
    const q = id
      ? supabase.from('tasks').update(values).eq('id', id).select('id').single()
      : supabase.from('tasks').insert(values).select('id').single()
    const { data, error } = await q
    setBusy(false)
    if (error) setError(errorText(error))
    else navigate(`/tasks/${data.id}`, { replace: true })
  }

  return (
    <Loader res={res} empty={(d) => !d && 'Задача не найдена.'}>
      {(d) =>
        d && (
          <article>
            <h2>{id ? 'Редактирование задачи' : 'Новая задача'}</h2>
            <form onSubmit={submit}>
              <label>
                Название
                <input name="title" defaultValue={d.task.title} required maxLength={200} pattern=".*\S.*" />
              </label>
              <label>
                Описание
                <textarea name="description" defaultValue={d.task.description} rows={4} maxLength={5000} />
              </label>
              <label>
                Объект
                <select name="object_id" defaultValue={d.task.object_id} required>
                  <option value="" disabled>
                    Выберите объект
                  </option>
                  {d.objects.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Исполнитель
                <select name="assignee_id" defaultValue={d.task.assignee_id} required>
                  <option value="" disabled>
                    Выберите исполнителя
                  </option>
                  {d.executors.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name}
                    </option>
                  ))}
                </select>
              </label>
              {d.executors.length === 0 && <p className="error">Нет пользователей с ролью «Исполнитель».</p>}
              {error && <p className="error">{error}</p>}
              <div className="actions">
                <button type="submit" disabled={busy} aria-busy={busy}>
                  Сохранить
                </button>
                <button type="button" className="secondary outline" onClick={() => navigate(-1)}>
                  Отмена
                </button>
              </div>
            </form>
          </article>
        )
      }
    </Loader>
  )
}

type MyTask = { id: string; title: string; status: Status; created_at: string; object: { id: string; name: string } | null }

export function MyTasks() {
  const { me } = useAuth()
  const res = useLoad(
    async () =>
      must(
        await supabase
          .from('tasks')
          .select('id, title, status, created_at, object:objects(id, name)')
          .eq('assignee_id', me!.id)
          .order('created_at', { ascending: false }),
      ) as unknown as MyTask[],
    [me?.id],
  )
  return (
    <>
      <h2>Мои задачи</h2>
      <Loader res={res} empty={(d) => d.length === 0 && 'Вам пока не назначено ни одной задачи.'}>
        {(tasks) => (
          <table>
            <thead>
              <tr>
                <th>Задача</th>
                <th>Объект</th>
                <th>Статус</th>
                <th>Создана</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  </td>
                  <td>{t.object?.name ?? '—'}</td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  <td>{fmtDate(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Loader>
    </>
  )
}
