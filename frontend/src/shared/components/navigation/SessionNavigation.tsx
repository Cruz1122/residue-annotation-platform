import { useEffect, useState } from 'preact/hooks';
import { readAuthSession, subscribeAuthSession, type AuthSession } from '@shared/auth/session';
import LucideIcon from '@shared/components/icons/LucideIcon.jsx';
import './session-navigation.css';

interface SessionNavigationProps {
  active?: string;
}

export default function SessionNavigation({ active = '' }: SessionNavigationProps) {
  const [session, setSession] = useState<AuthSession | null>(() => readAuthSession());

  useEffect(() => subscribeAuthSession(() => setSession(readAuthSession())), []);

  if (!session) return null;

  return (
    <div class="session-navigation">
      {session.user.role === 'admin' && (
        <a
          class={`sidebar-session-item ${active === 'users' ? 'active' : ''}`}
          href="/auth/users/"
          aria-current={active === 'users' ? 'page' : undefined}
        >
          <LucideIcon name="users-round" />
          <span>Usuarios</span>
        </a>
      )}
      <a
        class={`sidebar-session-item session-account ${active === 'session' ? 'active' : ''}`}
        href="/auth/session/"
        aria-current={active === 'session' ? 'page' : undefined}
        title={session.user.email}
      >
        <LucideIcon name="user-round" />
        <span class="session-identity">
          <strong>{session.user.email}</strong>
          <small>{session.user.role === 'admin' ? 'Admin' : 'Usuario'}</small>
        </span>
      </a>
    </div>
  );
}
