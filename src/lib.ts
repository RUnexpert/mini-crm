import { createClient } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY
if (!url || !key) throw new Error('Не заданы VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (см. .env.example)')

// Только публичный anon/publishable-ключ: всё, что он позволяет, ограничено RLS.
export const supabase = createClient(url, key)

export type Role = 'manager' | 'executor'
export type Status = 'new' | 'in_progress' | 'review' | 'accepted' | 'rework'
export type Profile = { id: string; full_name: string; role: Role }
export type Named = { full_name: string } | null

export const ROLE_LABEL: Record<Role, string> = { manager: 'Постановщик', executor: 'Исполнитель' }
export const STATUS_LABEL: Record<Status, string> = {
  new: 'Новая',
  in_progress: 'В работе',
  review: 'На проверке',
  accepted: 'Принята',
  rework: 'На доработке',
}

// Зеркало проверок из change_task_status(): интерфейс лишь прячет недоступные кнопки,
// окончательное решение принимает база.
export const ACTIONS: { from: Status; to: Status; role: Role; label: string; needsComment?: boolean }[] = [
  { from: 'new', to: 'in_progress', role: 'executor', label: 'Взять в работу' },
  { from: 'in_progress', to: 'review', role: 'executor', label: 'Отправить на проверку' },
  { from: 'rework', to: 'in_progress', role: 'executor', label: 'Взять в работу' },
  { from: 'review', to: 'accepted', role: 'manager', label: 'Принять' },
  { from: 'review', to: 'rework', role: 'manager', label: 'Вернуть на доработку', needsComment: true },
]

export const fmtDate = (iso: string) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })

/** Достаёт data из ответа Supabase или бросает его ошибку. */
export function must<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error
  return res.data as T
}

export function errorText(e: unknown): string {
  const err = (e ?? {}) as { message?: string; code?: string }
  const msg = err.message ?? ''
  if (err.code === 'PGRST301' || err.code === 'PGRST303' || /jwt/i.test(msg)) {
    void supabase.auth.signOut({ scope: 'local' }) // AuthProvider покажет «сессия истекла»
    return 'Сессия истекла, войдите снова'
  }
  if (/failed to fetch|network/i.test(msg)) return 'Нет связи с сервером, попробуйте ещё раз'
  if (/permission denied|row-level security/i.test(msg)) return 'Недостаточно прав для этого действия'
  return msg || 'Неизвестная ошибка'
}

/** Загрузка данных с состоянием загрузки/ошибки и ручным обновлением. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    fn().then(
      (data) => alive && setState({ data, loading: false }),
      (e) => alive && setState({ error: errorText(e), loading: false }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { ...state, reload: () => setTick((t) => t + 1) }
}
