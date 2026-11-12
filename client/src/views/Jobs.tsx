import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { JobRecord } from '@washlog/shared';
import { db, type LocalRecord } from '../db';
import { go, isToday } from '../hooks';

type LocalJob = JobRecord & { pending: boolean };

export function SyncBadge({ record, conflicted }: { record: LocalRecord; conflicted: boolean }) {
  const state = record.pending ? 'pending' : conflicted ? 'conflict' : 'synced';
  return <span className={`badge ${state}`}>{state}</span>;
}

export function Jobs() {
  const [showAll, setShowAll] = useState(false);
  const jobs = useLiveQuery(
    async () => (await db.records.where('type').equals('job').toArray()).filter((r) => !r.deleted) as LocalJob[],
    [],
    [] as LocalJob[],
  );
  const conflicted = useLiveQuery(
    async () => new Set((await db.conflicts.toArray()).map((c) => c.recordId)),
    [],
    new Set<string>(),
  );

  const today = jobs.filter((j) => isToday(j.createdAt));
  const list = (showAll ? jobs : today).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Day summary
  const washed = today.filter((j) => j.status === 'done' || j.status === 'paid');
  const kesTotal = today.filter((j) => j.status === 'paid').reduce((sum, j) => sum + j.priceKes, 0);
  const litres = washed.reduce((sum, j) => sum + j.waterLitres, 0);

  return (
    <section>
      <div className="summary">
        <div>
          <b>{washed.length}</b>
          <span>cars washed</span>
        </div>
        <div>
          <b>{kesTotal.toLocaleString()}</b>
          <span>KES paid</span>
        </div>
        <div>
          <b>{litres.toLocaleString()}</b>
          <span>litres used</span>
        </div>
      </div>

      <button className="primary big" onClick={() => go('job/new')}>
        + Add car
      </button>

      <div className="row between">
        <h2>{showAll ? 'All jobs' : "Today's jobs"}</h2>
        <button className="link" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show today' : `Show all (${jobs.length})`}
        </button>
      </div>

      {list.length === 0 && <p className="muted">No jobs yet. Tap “Add car”.</p>}
      <ul className="list">
        {list.map((job) => (
          <li key={job.id}>
            <a href={`#/job/${job.id}`} className="card">
              <div>
                <div className="plate">{job.plate}</div>
                <div className="muted">
                  {job.service} · {job.vehicleType} · {job.attendant}
                </div>
              </div>
              <div className="right">
                <div className="price">KES {job.priceKes.toLocaleString()}</div>
                <span className={`chip ${job.status}`}>{job.status}</span> <SyncBadge record={job} conflicted={conflicted.has(job.id)} />
              </div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
