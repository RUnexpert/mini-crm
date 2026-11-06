import type { ReactNode } from 'react'
import { STATUS_LABEL, type Status } from '../lib'

type Res<T> = { data?: T; error?: string; loading: boolean; reload: () => void }

/** Единая обработка загрузки, ошибки и пустого результата. */
export function Loader<T>(props: { res: Res<T>; empty?: (d: T) => string | false | null; children: (d: T) => ReactNode }) {
  const { res, empty, children } = props
  if (res.error)
    return (
      <p className="error">
        {res.error}{' '}
        <button className="outline secondary small" onClick={res.reload}>
          Повторить
        </button>
      </p>
    )
  if (res.data === undefined) return <p aria-busy="true">Загрузка…</p>
  const msg = empty?.(res.data)
  if (msg) return <p>{msg}</p>
  return children(res.data)
}

export const StatusBadge = ({ status }: { status: Status }) => (
  <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
)
