import { useState, type FormEvent, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth'
import { ROLE_LABEL, errorText, supabase } from './lib'
import { ObjectCard, ObjectForm, ObjectsList } from './pages/objects'
import { MyTasks, TaskCard, TaskForm } from './pages/tasks'

export default function App() {
  const { session, me, meError, signOut } = useAuth()

  if (session === undefined) return <main className="container" aria-busy="true" />
  if (!session) return <Login />
  if (meError) return <Shell><p className="error">Не удалось загрузить профиль: {meError}</p></Shell>
  if (me === undefined) return <main className="container" aria-busy="true" />
  if (me === null)
    return (
      <main className="container">
        <p>Для вашей учётной записи не назначена роль. Обратитесь к администратору.</p>
        <button onClick={signOut}>Выйти</button>
      </main>
    )

  const managerOnly = (el: ReactNode) => (me.role === 'manager' ? el : <Denied />)
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<ObjectsList />} />
        <Route path="/objects/new" element={managerOnly(<ObjectForm />)} />
        <Route path="/objects/:id" element={<ObjectCard />} />
        <Route path="/objects/:id/edit" element={managerOnly(<ObjectForm />)} />
        <Route path="/objects/:objectId/tasks/new" element={managerOnly(<TaskForm />)} />
        <Route path="/tasks/:id" element={<TaskCard />} />
        <Route path="/tasks/:id/edit" element={managerOnly(<TaskForm />)} />
        <Route path="/my" element={me.role === 'executor' ? <MyTasks /> : <Navigate to="/" />} />
        <Route path="*" element={<p>Страница не найдена.</p>} />
      </Routes>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  const { me, signOut } = useAuth()
  return (
    <>
      <header className="container">
        <nav>
          <ul>
            <li>
              <strong>Объекты и задачи</strong>
            </li>
            <li>
              <NavLink to="/" end>
                Объекты
              </NavLink>
            </li>
            {me?.role === 'executor' && (
              <li>
                <NavLink to="/my">Мои задачи</NavLink>
              </li>
            )}
          </ul>
          <ul>
            {me && (
              <li>
                <small>
                  {me.full_name} · {ROLE_LABEL[me.role]}
                </small>
              </li>
            )}
            <li>
              <button className="outline secondary" onClick={signOut}>
                Выйти
              </button>
            </li>
          </ul>
        </nav>
      </header>
      <main className="container">{children}</main>
    </>
  )
}

const Denied = () => <p className="error">Нет доступа: действие доступно только постановщику.</p>

function Login() {
  const { notice } = useAuth()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError(undefined)
    const { error } = await supabase.auth.signInWithPassword({
      email: String(f.get('email')).trim(),
      password: String(f.get('password')),
    })
    setBusy(false)
    if (error) setError(error.code === 'invalid_credentials' ? 'Неверный email или пароль' : errorText(error))
  }

  return (
    <main className="container narrow">
      <article>
        <h2>Вход</h2>
        {notice && !error && <p className="notice">{notice}</p>}
        <form onSubmit={submit}>
          <label>
            Email
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Пароль
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={busy} aria-busy={busy}>
            Войти
          </button>
        </form>
        <small>Регистрация закрыта. Учётные записи создаёт администратор.</small>
      </article>
    </main>
  )
}
