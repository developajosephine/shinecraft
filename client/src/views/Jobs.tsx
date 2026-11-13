import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { JOB_STATUSES, type JobRecord, type JobStatus } from '@washlog/shared';
import { db } from '../db';
import { isToday } from '../hooks';
import { NEXT_STEP, STATUS_LABEL, VEHICLE_LABEL, cap } from '../labels';
import { updateRecord } from '../store';
import { toast } from '../toast';
import { Empty, Icon, Sheet, StatusChip, SyncBadge } from '../ui';

type LocalJob = JobRecord & { pending: boolean };

/** "Take payment": pick cash or M-Pesa, then the job becomes paid in one queued change. */
function PaySheet({ job, onClose, onPaid }: { job: LocalJob; onClose: () => void; onPaid: () => void }) {
  const [mpesa, setMpesa] = useState(false);
  const [code, setCode] = useState('');

  const pay = async (method: 'cash' | 'mpesa') => {
    await updateRecord(db, job.id, {
      status: 'paid',
      paymentMethod: method,
      mpesaCode: method === 'mpesa' ? code.trim().toUpperCase() || null : null,
    });
    toast(`${job.plate} paid — KES ${job.priceKes.toLocaleString()}`);
    onPaid();
    onClose();
  };

  return (
    <Sheet title={`Take payment for ${job.plate}`} onClose={onClose}>
      <p className="sheet-amount">KES {job.priceKes.toLocaleString()}</p>
      {mpesa ? (
        <div className="form">
          <div className="field">
            <label htmlFor="pay-code">M-Pesa code (optional)</label>
            <input id="pay-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} maxLength={32} autoCapitalize="characters" />
          </div>
          <button className="btn primary big" onClick={() => pay('mpesa')}>
            Confirm M-Pesa payment
          </button>
          <button className="btn ghost" onClick={() => setMpesa(false)}>
            Back
          </button>
        </div>
      ) : (
        <div className="pay-options">
          <button className="btn primary big" onClick={() => pay('cash')}>
            Paid in cash
          </button>
          <button className="btn big" onClick={() => setMpesa(true)}>
            Paid by M-Pesa
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
    </Sheet>
  );
}

export function Jobs({ onChanged }: { onChanged: () => void }) {
  const [scope, setScope] = useState<'today' | 'all'>('today');
  const [filter, setFilter] = useState<'all' | JobStatus>('all');
  const [paying, setPaying] = useState<LocalJob | null>(null);

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
  const inScope = scope === 'today' ? today : jobs;
  const list = inScope
    .filter((j) => filter === 'all' || j.status === filter)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Day summary
  const washed = today.filter((j) => j.status === 'done' || j.status === 'paid');
  const kesTotal = today.filter((j) => j.status === 'paid').reduce((sum, j) => sum + j.priceKes, 0);
  const litres = washed.reduce((sum, j) => sum + j.waterLitres, 0);

  const advance = async (job: LocalJob) => {
    const step = NEXT_STEP[job.status];
    if (!step) return;
    if (step.next === 'paid') return setPaying(job);
    await updateRecord(db, job.id, { status: step.next });
    toast(`${job.plate}: ${STATUS_LABEL[step.next].toLowerCase()}`);
    onChanged();
  };

  return (
    <section>
      <div className="summary" aria-label="Today so far">
        <div>
          <b>{washed.length}</b>
          <span>cars washed today</span>
        </div>
        <div>
          <b>
            <small>KES</small> {kesTotal.toLocaleString()}
          </b>
          <span>paid today</span>
        </div>
        <div>
          <b>
            {litres.toLocaleString()} <small>L</small>
          </b>
          <span>water used</span>
        </div>
      </div>

      <div className="row between section-head">
        <h2>{scope === 'today' ? 'Today’s jobs' : 'All jobs'}</h2>
        <div className="segmented" role="group" aria-label="Which jobs to show">
          <button className={scope === 'today' ? 'on' : ''} aria-pressed={scope === 'today'} onClick={() => setScope('today')}>
            Today
          </button>
          <button className={scope === 'all' ? 'on' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            All
          </button>
        </div>
      </div>

      <div className="filters" role="group" aria-label="Filter by status">
        <button className={`filter ${filter === 'all' ? 'on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All <span>{inScope.length}</span>
        </button>
        {JOB_STATUSES.map((s) => (
          <button key={s} className={`filter ${filter === s ? 'on' : ''}`} aria-pressed={filter === s} onClick={() => setFilter(s)}>
            {STATUS_LABEL[s]} <span>{inScope.filter((j) => j.status === s).length}</span>
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <Empty icon="car" title={inScope.length > 0 ? `No ${filter} jobs` : scope === 'today' ? 'No jobs today yet' : 'No jobs yet'}>
          {inScope.length > 0
            ? 'Choose another status above to see more.'
            : scope === 'today' && jobs.length > 0
              ? 'Tap “Add car” for the next vehicle, or “All” to see earlier days.'
              : 'Tap “Add car” when the next vehicle arrives.'}
        </Empty>
      ) : (
        <ul className="list">
          {list.map((job) => {
            const step = NEXT_STEP[job.status];
            return (
              <li key={job.id} className={`job st-${job.status}`}>
                <a href={`#/job/${job.id}`} className="job-main" aria-label={`Edit ${job.plate}`}>
                  <div className="job-top">
                    <span className="plate">{job.plate}</span>
                    <span className="price">KES {job.priceKes.toLocaleString()}</span>
                  </div>
                  <div className="muted">
                    {cap(job.service)} wash · {VEHICLE_LABEL[job.vehicleType]} · {job.attendant}
                  </div>
                  <div className="job-tags">
                    <StatusChip status={job.status} />
                    <SyncBadge record={job} conflicted={conflicted.has(job.id)} />
                  </div>
                </a>
                {step && (
                  <button className="job-next" onClick={() => advance(job)}>
                    {step.label}
                    <Icon name="chevron" size={18} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <a className="fab" href="#/job/new">
        <Icon name="plus" size={22} /> Add car
      </a>

      {paying && <PaySheet job={paying} onClose={() => setPaying(null)} onPaid={onChanged} />}
    </section>
  );
}
