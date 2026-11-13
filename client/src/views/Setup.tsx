import { useState, type FormEvent } from 'react';
import { db } from '../db';
import { setupDevice } from '../store';
import { Icon } from '../ui';

export function Setup() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await setupDevice(db, name);
    } catch {
      setError('Enter a name for this phone, for example “Attendant 1”.');
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
        <form onSubmit={submit} className="form card-pad">
          <div className={`field ${error ? 'invalid' : ''}`}>
            <label htmlFor="device-name">Name this phone</label>
            <input
              id="device-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Attendant 1, Cashier"
              maxLength={60}
            />
            {error ? <p className="field-error">{error}</p> : <p className="hint">Shown on the jobs this phone records.</p>}
          </div>
          <button className="btn primary big" type="submit">
            Start
          </button>
        </form>
      </main>
    </div>
  );
}
