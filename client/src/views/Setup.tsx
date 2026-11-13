import { useEffect, useState, type FormEvent } from 'react';
import { ROLE_LABEL } from '../labels';
import { login, loginOptions, type LoginOptions } from '../api';
import { db } from '../db';
import { ensureDeviceId, saveSession } from '../store';
import { Icon } from '../ui';

/** Name + PIN. Needs a connection once; after that the phone stays logged in and works offline. */
export function Login({ expired, pending }: { expired: boolean; pending: number }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<LoginOptions | null>(null);

  useEffect(() => {
    let cancelled = false;
    loginOptions().then(
      (o) => !cancelled && setOptions(o),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !pin) return setError('Enter your name and PIN.');
    setBusy(true);
    setError('');
    try {
      const session = await login(name.trim(), pin, await ensureDeviceId(db));
      await saveSession(db, { token: session.token, expiresAt: session.expiresAt, user: session.user });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log in.');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <main className="setup">
        <span className="setup-mark">
          <Icon name="drop" size={34} />
        </span>
        <h1>WashLog</h1>
        <p className="lead">Log car washes and supplies, even with no signal.</p>
        {expired && (
          <p className="notice">
            Your login ended. Log in again to keep syncing.
            {pending > 0 && ` ${pending} unsynced ${pending === 1 ? 'change is' : 'changes are'} safe on this phone.`}
          </p>
        )}
        <form onSubmit={submit} className="form card-pad">
          <div className="field">
            <label htmlFor="login-name">Your name</label>
            <input id="login-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" maxLength={60} />
          </div>
          <div className={`field ${error ? 'invalid' : ''}`}>
            <label htmlFor="login-pin">PIN</label>
            <input
              id="login-pin"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoComplete="current-password"
              maxLength={8}
            />
            {error ? <p className="field-error">{error}</p> : <p className="hint">Logging in needs a connection. After that the app works offline.</p>}
          </div>
          <button className="btn primary big" type="submit" disabled={busy}>
            {busy ? 'Logging in…' : 'Log in'}
          </button>
        </form>
        {options?.demoMode && (
          <div className="card-pad demo-accounts">
            <strong>Demo accounts</strong>
            <p className="hint">Synthetic accounts for this demo. Tap one, then enter PIN {options.demoPin}.</p>
            <div className="demo-buttons">
              {options.demoAccounts.map((a) => (
                <button type="button" key={a.name} className="btn" onClick={() => setName(a.name)}>
                  {a.name} · {ROLE_LABEL[a.role]}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
