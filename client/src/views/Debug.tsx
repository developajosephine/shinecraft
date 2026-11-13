import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Op } from '@washlog/shared';
import { demoDropAckNext, demoFailNext, demoStatus, type DemoStatus } from '../api';
import { db } from '../db';
import { shortId } from '../hooks';
import { toast } from '../toast';
import { Icon } from '../ui';

export function Debug({ online }: { online: boolean }) {
  const queue = useLiveQuery(() => db.opQueue.orderBy('seq').toArray(), [], [] as Op[]);
  const acked = useLiveQuery(() => db.ackedOps.count(), [], 0);
  const records = useLiveQuery(() => db.records.count(), [], 0);
  const deviceId = useLiveQuery(async () => (await db.meta.get('deviceId'))?.value as string | undefined);
  const [demo, setDemo] = useState<DemoStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void demoStatus().then((s) => !cancelled && setDemo(s));
    return () => {
      cancelled = true;
    };
  }, [online]);

  const toggle = async (action: () => Promise<DemoStatus>, message: string) => {
    try {
      setDemo(await action());
      toast(message, 'info');
    } catch {
      setDemo(null);
      toast('Could not reach the server', 'bad');
    }
  };

  return (
    <section>
      <a className="link-row back" href="#/sync">
        <Icon name="back" size={18} /> Back to Sync
      </a>
      <h2>Developer view</h2>
      <dl className="facts">
        <dt>Device ID</dt>
        <dd className="mono">{deviceId ? shortId(deviceId) : '—'}</dd>
        <dt>Records in map</dt>
        <dd>{records}</dd>
        <dt>Acked op IDs</dt>
        <dd>{acked}</dd>
        <dt>Queued ops</dt>
        <dd>{queue.length}</dd>
      </dl>

      <h3>Operation queue (FIFO, head first)</h3>
      {queue.length === 0 ? (
        <p className="muted">Queue is empty — everything is synced.</p>
      ) : (
        <div className="table-wrap">
          <table className="queue">
            <thead>
              <tr>
                <th>seq</th>
                <th>opId</th>
                <th>type</th>
                <th>record</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((op, i) => (
                <tr key={op.seq} className={i === 0 ? 'head' : ''}>
                  <td>{op.seq}</td>
                  <td>{shortId(op.opId)}</td>
                  <td>
                    {op.type} {op.recordType}
                  </td>
                  <td>{shortId(op.recordId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {demo?.demoMode && (
        <>
          <h3>Demo toggles (server DEMO_MODE)</h3>
          <div className="demo-buttons">
            <button className="btn" onClick={() => toggle(demoFailNext, 'Armed: the next sync will fail')} disabled={demo.failNext}>
              {demo.failNext ? 'Fail next sync: armed' : 'Fail next sync'}
            </button>
            <button className="btn" onClick={() => toggle(demoDropAckNext, 'Armed: the next acknowledgment will be dropped')} disabled={demo.dropAckNext}>
              {demo.dropAckNext ? 'Drop next ack: armed' : 'Drop next ack'}
            </button>
          </div>
          <p className="muted">
            “Fail next sync” makes the server reject the next op without applying it. “Drop next ack” applies and commits
            the next op, then answers 503 — the retry must come back as a duplicate.
          </p>
        </>
      )}
    </section>
  );
}
