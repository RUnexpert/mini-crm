import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { errorText, must, supabase, useLoad, type Named, type Status } from '../lib'
import { Loader, StatusBadge } from './ui'

type ObjectRow = { id: string; name: string; address: string; tasks: { count: number }[] }
type ObjectTask = { id: string; title: string; status: Status; assignee: Named }

export function ObjectsList() {
  const { me } = useAuth()
  const res = useLoad(
    async () =>
      must(await supabase.from('objects').select('id, name, address, tasks(count)').order('created_at')) as ObjectRow[],
    [],
  )
  return (
    <>
      <div className="row">
        <h2>Объекты</h2>
        {me?.role === 'manager' && (
          <Link role="button" to="/objects/new">
            Новый объект
          </Link>
        )}
      </div>
      <Loader res={res} empty={(d) => d.length === 0 && (me?.role === 'manager' ? 'Объектов пока нет.' : 'Вам пока не назначено ни одной задачи.')}>
        {(objects) => (
          <table>
            <thead>
              <tr>
                <th>Название</th>
                <th>Адрес</th>
                <th>{me?.role === 'manager' ? 'Задач' : 'Моих задач'}</th>
              </tr>
            </thead>
            <tbody>
              {objects.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/objects/${o.id}`}>{o.name}</Link>
                  </td>
                  <td>{o.address}</td>
                  <td>{o.tasks[0]?.count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Loader>
    </>
  )
}

export function ObjectCard() {
  const { id } = useParams() as { id: string }
  const { me } = useAuth()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const res = useLoad(async () => {
    const object = must(await supabase.from('objects').select('id, name, address').eq('id', id).maybeSingle()) as { name: string; address: string } | null
    const tasks = must(
      await supabase
        .from('tasks')
        .select('id, title, status, assignee:profiles!tasks_assignee_id_fkey(full_name)')
        .eq('object_id', id)
        .order('created_at'),
    ) as unknown as ObjectTask[]
    return object && { object, tasks }
  }, [id])

  async function remove(taskCount: number) {
    const extra = taskCount ? ` Вместе с ним будут удалены задачи (${taskCount}).` : ''
    if (!confirm(`Удалить объект?${extra} История задач сохранится в базе.`)) return
    setBusy(true)
    const { error } = await supabase.rpc('delete_object', { p_object_id: id })
    setBusy(false)
    if (error) setError(errorText(error))
    else navigate('/')
  }

  return (
    <Loader res={res} empty={(d) => !d && 'Объект не найден или у вас нет к нему доступа.'}>
      {(d) =>
        d && (
          <>
            <p>
              <Link to="/">← Объекты</Link>
            </p>
            <div className="row">
              <hgroup>
                <h2>{d.object.name}</h2>
                <p>{d.object.address}</p>
              </hgroup>
              {me?.role === 'manager' && (
                <div className="actions">
                  <Link role="button" className="secondary outline" to={`/objects/${id}/edit`}>
                    Редактировать
                  </Link>
                  <button className="secondary" disabled={busy} onClick={() => remove(d.tasks.length)}>
                    Удалить
                  </button>
                </div>
              )}
            </div>
            {error && <p className="error">{error}</p>}
            <div className="row">
              <h3>{me?.role === 'manager' ? 'Задачи' : 'Мои задачи на объекте'}</h3>
              {me?.role === 'manager' && (
                <Link role="button" to={`/objects/${id}/tasks/new`}>
                  Новая задача
                </Link>
              )}
            </div>
            {d.tasks.length === 0 ? (
              <p>Задач нет.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Задача</th>
                    <th>Исполнитель</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {d.tasks.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                      </td>
                      <td>{t.assignee?.full_name ?? '—'}</td>
                      <td>
                        <StatusBadge status={t.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )
      }
    </Loader>
  )
}

export function ObjectForm() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const res = useLoad(
    async () => (id ? must(await supabase.from('objects').select('name, address').eq('id', id).maybeSingle()) : { name: '', address: '' }),
    [id],
  )

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    const f = new FormData(e.currentTarget)
    const values = { name: String(f.get('name')).trim(), address: String(f.get('address')).trim() }
    setBusy(true)
    setError(undefined)
    const q = id
      ? supabase.from('objects').update(values).eq('id', id).select('id').single()
      : supabase.from('objects').insert(values).select('id').single()
    const { data, error } = await q
    setBusy(false)
    if (error) setError(errorText(error))
    else navigate(`/objects/${data.id}`)
  }

  return (
    <Loader res={res} empty={(d) => !d && 'Объект не найден.'}>
      {(d) =>
        d && (
          <article>
            <h2>{id ? 'Редактирование объекта' : 'Новый объект'}</h2>
            <form onSubmit={submit}>
              <label>
                Название
                <input name="name" defaultValue={d.name} required maxLength={200} pattern=".*\S.*" />
              </label>
              <label>
                Адрес
                <input name="address" defaultValue={d.address} required maxLength={500} pattern=".*\S.*" />
              </label>
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

