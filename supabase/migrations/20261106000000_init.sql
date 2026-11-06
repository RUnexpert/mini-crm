-- Мини-CRM «Объекты и задачи»: схема, права доступа, RLS, бизнес-логика статусов.
--
-- Модель защиты (кратко):
--   * чтение      — RLS-политики (только роль authenticated, anon не получает ничего);
--   * запись      — RLS + права на уровне КОЛОНОК: клиент физически не может записать
--                   status, author_id, created_at, deleted_at, роль пользователя;
--   * статус      — меняется только функцией change_task_status(): блокировка строки,
--                   проверка перехода и роли, запись истории в той же транзакции;
--   * история     — только SELECT; пишут её лишь триггер создания и change_task_status();
--   * удаление    — мягкое (deleted_at), через delete_task()/delete_object(); DELETE запрещён всем.

-- ---------------------------------------------------------------- типы

create type public.user_role as enum ('manager', 'executor');           -- постановщик / исполнитель
create type public.task_status as enum ('new', 'in_progress', 'review', 'accepted', 'rework');

-- ---------------------------------------------------------------- таблицы

-- Роль хранится здесь, а не в user_metadata (её пользователь может менять сам).
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text not null check (full_name ~ '\S'),
  role       public.user_role not null,
  created_at timestamptz not null default now()
);

create table public.objects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (name ~ '\S' and length(name) <= 200),
  address    text not null check (address ~ '\S' and length(address) <= 500),
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  object_id   uuid not null references public.objects (id),
  title       text not null check (title ~ '\S' and length(title) <= 200),
  description text not null default '' check (length(description) <= 5000),
  assignee_id uuid not null references public.profiles (id),
  status      public.task_status not null default 'new',
  author_id   uuid not null default auth.uid() references public.profiles (id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index tasks_object_id_idx on public.tasks (object_id);
create index tasks_assignee_id_idx on public.tasks (assignee_id);

create table public.task_status_history (
  id          bigint generated always as identity primary key,
  task_id     uuid not null references public.tasks (id),
  actor_id    uuid not null references public.profiles (id),
  created_at  timestamptz not null default now(),
  from_status public.task_status,                -- null = запись о создании задачи
  to_status   public.task_status not null,
  comment     text,
  constraint history_comment_not_blank check (comment is null or comment ~ '\S'),
  constraint history_rework_needs_comment check (to_status <> 'rework' or comment is not null),
  -- Даже в обход функций (например, под service_role) в историю не попадёт недопустимый переход.
  constraint history_valid_transition check (
    (from_status is null and to_status = 'new')
    or from_status::text || '>' || to_status::text in (
      'new>in_progress', 'in_progress>review', 'review>accepted', 'review>rework', 'rework>in_progress'
    )
  )
);

create index task_status_history_task_id_idx on public.task_status_history (task_id, created_at);

-- ---------------------------------------------------------------- вспомогательные функции
-- Схема private не публикуется через API. SECURITY DEFINER позволяет читать profiles
-- без RLS, поэтому политики не вызывают друг друга рекурсивно.

create schema private;
grant usage on schema private to authenticated;

create function private.user_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid()
$$;

create function private.is_manager() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.user_role() = 'manager', false)
$$;

revoke all on function private.user_role(), private.is_manager() from public, anon;
grant execute on function private.user_role(), private.is_manager() to authenticated;

-- ---------------------------------------------------------------- триггеры задач

-- Исполнитель — только пользователь с ролью executor; объект — только не удалённый.
create function private.tasks_validate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = new.assignee_id and role = 'executor') then
    raise exception 'Исполнителем можно назначить только пользователя с ролью «Исполнитель»'
      using errcode = '23514';
  end if;
  if not exists (select 1 from public.objects where id = new.object_id and deleted_at is null) then
    raise exception 'Объект не найден или удалён' using errcode = '23503';
  end if;
  return new;
end $$;

create trigger tasks_validate
  before insert or update of assignee_id, object_id on public.tasks
  for each row execute function private.tasks_validate();

-- Решение: создание задачи пишется в историю как переход «— → Новая» (from_status = null).
create function private.tasks_log_creation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.task_status_history (task_id, actor_id, from_status, to_status)
  values (new.id, new.author_id, null, new.status);
  return null;
end $$;

create trigger tasks_log_creation
  after insert on public.tasks
  for each row execute function private.tasks_log_creation();

-- ---------------------------------------------------------------- RLS

alter table public.profiles enable row level security;
alter table public.objects enable row level security;
alter table public.tasks enable row level security;
alter table public.task_status_history enable row level security;

-- Профили: постановщик видит всех; исполнитель — себя и постановщиков (авторы задач и записей истории).
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or role = 'manager' or (select private.is_manager()));

-- Объекты: постановщик — все; исполнитель — только где у него есть задачи.
create policy objects_select on public.objects for select to authenticated
  using (
    deleted_at is null
    and (
      (select private.is_manager())
      or exists (
        select 1 from public.tasks t
        where t.object_id = objects.id
          and t.assignee_id = (select auth.uid())
          and t.deleted_at is null
      )
    )
  );
create policy objects_insert on public.objects for insert to authenticated
  with check ((select private.is_manager()));
create policy objects_update on public.objects for update to authenticated
  using ((select private.is_manager()) and deleted_at is null)
  with check ((select private.is_manager()));

-- Задачи: постановщик — все; исполнитель — только назначенные ему. Менять может только постановщик.
create policy tasks_select on public.tasks for select to authenticated
  using (deleted_at is null and ((select private.is_manager()) or assignee_id = (select auth.uid())));
create policy tasks_insert on public.tasks for insert to authenticated
  with check ((select private.is_manager()));
create policy tasks_update on public.tasks for update to authenticated
  using ((select private.is_manager()) and deleted_at is null)
  with check ((select private.is_manager()));

-- История: постановщик и ТЕКУЩИЙ исполнитель задачи. Политик на запись нет вовсе.
create policy history_select on public.task_status_history for select to authenticated
  using (
    exists (
      select 1 from public.tasks t
      where t.id = task_status_history.task_id
        and t.deleted_at is null
        and ((select private.is_manager()) or t.assignee_id = (select auth.uid()))
    )
  );

-- ---------------------------------------------------------------- права на таблицы
-- Supabase по умолчанию выдаёт anon/authenticated ВСЕ права на новые таблицы — забираем
-- и выдаём точечно. Колонки status/author_id/created_at/deleted_at/role не записываются клиентом.

revoke all on public.profiles, public.objects, public.tasks, public.task_status_history from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.profiles, public.objects, public.tasks, public.task_status_history to authenticated;
grant insert (name, address), update (name, address) on public.objects to authenticated;
grant insert (object_id, title, description, assignee_id),
      update (object_id, title, description, assignee_id) on public.tasks to authenticated;

-- ---------------------------------------------------------------- RPC

-- Единственный путь смены статуса.
create function public.change_task_status(p_task_id uuid, p_new_status public.task_status, p_comment text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_role    public.user_role := private.user_role();
  v_task    public.tasks;
  v_comment text := nullif(regexp_replace(p_comment, '^\s+|\s+$', '', 'g'), ''); -- trim любых пробельных символов
  v_move    text;
begin
  if v_uid is null or v_role is null then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;

  -- FOR UPDATE: параллельные смены статуса одной задачи выполняются строго по очереди,
  -- второй запрос увидит уже новый статус и получит отказ.
  select * into v_task
    from public.tasks
   where id = p_task_id
     and deleted_at is null
     and (v_role = 'manager' or assignee_id = v_uid)
     for update;
  if not found then
    raise exception 'Задача не найдена или нет доступа' using errcode = 'P0002';
  end if;

  v_move := v_task.status::text || '>' || p_new_status::text;
  if (
       (v_role = 'executor' and v_move in ('new>in_progress', 'in_progress>review', 'rework>in_progress'))
    or (v_role = 'manager'  and v_move in ('review>accepted', 'review>rework'))
  ) is not true then
    raise exception 'Переход статуса % → % запрещён', v_task.status, p_new_status using errcode = '42501';
  end if;

  if p_new_status = 'rework' and v_comment is null then
    raise exception 'Для возврата на доработку нужен комментарий' using errcode = '23514';
  end if;

  update public.tasks set status = p_new_status where id = v_task.id;

  insert into public.task_status_history (task_id, actor_id, from_status, to_status, comment)
  values (v_task.id, v_uid, v_task.status, p_new_status, v_comment);
end $$;

-- Мягкое удаление: история остаётся в базе, удалённое скрывается RLS.
create function public.delete_task(p_task_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_manager() then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  update public.tasks set deleted_at = now() where id = p_task_id and deleted_at is null;
  if not found then
    raise exception 'Задача не найдена' using errcode = 'P0002';
  end if;
end $$;

-- Удаление объекта удаляет (мягко) и все его задачи.
create function public.delete_object(p_object_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_manager() then
    raise exception 'Недостаточно прав' using errcode = '42501';
  end if;
  update public.objects set deleted_at = now() where id = p_object_id and deleted_at is null;
  if not found then
    raise exception 'Объект не найден' using errcode = 'P0002';
  end if;
  update public.tasks set deleted_at = now() where object_id = p_object_id and deleted_at is null;
end $$;

revoke all on function public.change_task_status(uuid, public.task_status, text),
                       public.delete_task(uuid),
                       public.delete_object(uuid) from public, anon;
grant execute on function public.change_task_status(uuid, public.task_status, text),
                          public.delete_task(uuid),
                          public.delete_object(uuid) to authenticated;
