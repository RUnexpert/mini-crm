import type { Session } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { errorText, supabase, type Profile } from './lib'

type Auth = {
  session: Session | null | undefined // undefined — ещё не известно
  me: Profile | null | undefined // null — профиль (роль) не настроен
  meError?: string
  notice?: string
  signOut: () => Promise<void>
}

const AuthCtx = createContext<Auth>(null as unknown as Auth)
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [me, setMe] = useState<Profile | null | undefined>(undefined)
  const [meError, setMeError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const manualSignOut = useRef(false)

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'SIGNED_OUT' && !manualSignOut.current) setNotice('Сессия истекла, войдите снова')
      if (event === 'SIGNED_IN') setNotice(undefined)
      manualSignOut.current = false
      setSession(s)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const uid = session?.user.id
  useEffect(() => {
    setMe(undefined)
    setMeError(undefined)
    if (!uid) return
    supabase
      .from('profiles')
      .select('id, full_name, role')
      .eq('id', uid)
      .maybeSingle()
      .then(({ data, error }) => (error ? setMeError(errorText(error)) : setMe(data as Profile | null)))
  }, [uid])

  const signOut = async () => {
    manualSignOut.current = true
    await supabase.auth.signOut()
  }

  return <AuthCtx.Provider value={{ session, me, meError, notice, signOut }}>{children}</AuthCtx.Provider>
}
