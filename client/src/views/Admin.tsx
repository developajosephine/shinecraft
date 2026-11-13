import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ROLES, type Role, type User } from '@washlog/shared';
import { auditLog, createUser, listUsers, updateUser, type AuditEntry } from '../api';
import { formatTime } from '../hooks';
import { ROLE_LABEL } from '../labels';
import { toast } from '../toast';
import { Empty, Icon, Sheet, Tiles } from '../ui';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const BackLink = () => (
  <a className="link-row back" href="#/sync">
    <Icon name="back" size={18} /> Back
  </a>
);

/** Manager only: who can log in, and as what. Needs a connection (accounts live on the server). */
export function Users({ myId }: { myId: string }) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState({ name: '', role: 'attendant' as Role, pin: '' });
  const [formError, setFormError] = useState('');

  const load = useCallback(() => {
    listUsers().then(
      (u) => {
        setUsers(u);
        setError('');
      },
      (err) => setError(message(err)),
    );
  }, []);
  useEffect(load, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setFormError('Enter a name.');
    if (!/^\d{4,8}$/.test(form.pin)) return setFormError('PIN must be 4 to 8 digits.');
    try {
      await createUser(form.name.trim(), form.role, form.pin);
      toast(`${form.name.trim()} added`);
      setAdding(false);
      setForm({ name: '', role: 'attendant', pin: '' });
      setFormError('');
      load();
    } catch (err) {
      setFormError(message(err));
    }
  };

  const change = async (user: User, changes: { role?: Role; active?: boolean; pin?: string }, done: string) => {
    try {
      await updateUser(user.id, changes);
      toast(done);
      setEditing(null);
      setForm({ name: '', role: 'attendant', pin: '' });
      setFormError('');
      load();
    } catch (err) {
      setFormError(message(err));
    }
  };

  return (
    <section>
      <BackLink />
      <div className="row between section-head">
        <h2>Users</h2>
        <button className="btn small" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Add user
        </button>
      </div>
      <p className="muted">Attendants log washes. Cashiers also take payment and change prices. Managers can also delete, and manage users.</p>

      {error && <p className="field-error">{error}</p>}
      {users && users.length === 0 && <Empty icon="check" title="No users yet" />}
      <ul className="list">
        {(users ?? []).map((u) => (
          <li key={u.id} className="user-row">
            <div>
              <div className="supply-name">
                {u.name} {u.id === myId && <span className="hint-inline">(you)</span>}
              </div>
              <div className="job-tags">
                <span className={`chip ${u.role === 'manager' ? 'st-paid' : u.role === 'cashier' ? 'st-washing' : 'st-waiting'}`}>{ROLE_LABEL[u.role]}</span>
                {!u.active && <span className="chip st-low">Switched off</span>}
              </div>
            </div>
            <button
              className="btn small"
              onClick={() => {
                setEditing(u);
                setForm({ name: u.name, role: u.role, pin: '' });
                setFormError('');
              }}
            >
              Manage
            </button>
          </li>
        ))}
      </ul>

      {adding && (
        <Sheet title="Add user" onClose={() => setAdding(false)}>
          <form className="form" onSubmit={add}>
            <div className="field">
              <label htmlFor="u-name">Name</label>
              <input id="u-name" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} />
            </div>
            <Tiles label="Role" columns={3} value={form.role} onChange={(role) => setForm({ ...form, role })} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
            <div className="field">
              <label htmlFor="u-pin">PIN (4 to 8 digits)</label>
              <input id="u-pin" type="password" inputMode="numeric" autoComplete="new-password" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} maxLength={8} />
            </div>
            {formError && <p className="field-error">{formError}</p>}
            <button className="btn primary big" type="submit">
              Add user
            </button>
          </form>
        </Sheet>
      )}

      {editing && (
        <Sheet title={editing.name} onClose={() => setEditing(null)}>
          <div className="form">
            <Tiles
              label="Role"
              columns={3}
              value={form.role}
              onChange={(role) => void change(editing, { role }, `${editing.name} is now ${ROLE_LABEL[role].toLowerCase()}`)}
              options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            />
            <div className="field">
              <label htmlFor="u-newpin">New PIN (4 to 8 digits)</label>
              <input id="u-newpin" type="password" inputMode="numeric" autoComplete="new-password" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} maxLength={8} />
            </div>
            <button
              className="btn"
              onClick={() =>
                /^\d{4,8}$/.test(form.pin) ? void change(editing, { pin: form.pin }, `PIN changed for ${editing.name}`) : setFormError('PIN must be 4 to 8 digits.')
              }
            >
              Change PIN
            </button>
            <button
              className={`btn ${editing.active ? 'danger' : ''}`}
              onClick={() => void change(editing, { active: !editing.active }, `${editing.name} ${editing.active ? 'switched off' : 'switched on'}`)}
            >
              {editing.active ? 'Switch off this account' : 'Switch this account back on'}
            </button>
            {formError && <p className="field-error">{formError}</p>}
            <p className="hint">Changing the role or PIN, or switching the account off, logs that person out everywhere.</p>
          </div>
        </Sheet>
      )}
    </section>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'job.create': 'Added a job',
  'job.update': 'Changed a job',
  'job.delete': 'Deleted a job',
  'supply.create': 'Added a supply',
  'supply.update': 'Changed a supply',
  'supply.delete': 'Removed a supply',
  'auth.login': 'Logged in',
  'auth.logout': 'Logged out',
  'user.create': 'Added a user',
  'user.update': 'Changed a user',
};

/** Manager only: who did what, newest first. */
export function Activity() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    auditLog().then(setEntries, (err) => setError(message(err)));
  }, []);

  return (
    <section>
      <BackLink />
      <h2 className="section-head">Activity</h2>
      <p className="muted">Every change, login and refused action, with who did it. The last 200 are shown.</p>
      {error && <p className="field-error">{error}</p>}
      {entries && entries.length === 0 && <Empty icon="check" title="Nothing yet" />}
      <ul className="list">
        {(entries ?? []).map((e) => {
          const bad = e.outcome === 'rejected' || e.outcome === 'failed';
          return (
            <li key={e.id} className="user-row">
              <div>
                <div className="supply-name">
                  {e.userName} <span className="hint-inline">· {e.role}</span>
                </div>
                <div className="muted">
                  {ACTION_LABEL[e.action] ?? e.action}
                  {e.detail?.name ? `: ${e.detail.name}` : ''}
                  {e.detail?.fields?.length ? ` (${e.detail.fields.join(', ')})` : ''}
                </div>
                {e.detail?.reasons?.map((r) => (
                  <div key={r} className="field-error">
                    {r}
                  </div>
                ))}
                <div className="muted small">{formatTime(e.at)}</div>
              </div>
              <span className={`chip ${bad ? 'st-low' : 'st-done'}`}>{e.outcome === 'rejected' ? 'Refused' : e.outcome === 'failed' ? 'Failed' : 'OK'}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
