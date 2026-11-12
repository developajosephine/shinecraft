import { useState, type FormEvent } from 'react';
import { db } from '../db';
import { setupDevice } from '../store';

export function Setup() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await setupDevice(db, name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="app">
      <main className="setup">
        <h1>WashLog</h1>
        <p>Log car washes and supplies, even with no signal. Name this phone to start.</p>
        <form onSubmit={submit} className="form">
          <label>
            Device name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Attendant 1, Cashier"
              maxLength={60}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button className="primary big" type="submit">
            Start
          </button>
        </form>
      </main>
    </div>
  );
}
