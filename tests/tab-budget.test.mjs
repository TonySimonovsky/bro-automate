import test from 'node:test';
import assert from 'node:assert/strict';
import { TabBudget } from '../extension/lib/tab-budget.js';

test('FIFO acquire/release with max=2 and 3 concurrent acquires; 3rd waits', async () => {
  const b = new TabBudget();
  b.setMax(2);
  const order = [];
  const a1 = b.acquire().then((h) => {
    order.push(1);
    return h;
  });
  const a2 = b.acquire().then((h) => {
    order.push(2);
    return h;
  });
  const a3 = b.acquire().then((h) => {
    order.push(3);
    return h;
  });
  const h1 = await a1;
  const h2 = await a2;
  assert.deepEqual(order, [1, 2]);
  let thirdDone = false;
  void a3.then(() => {
    thirdDone = true;
  });
  assert.equal(thirdDone, false);
  h1.release();
  const h3 = await a3;
  assert.deepEqual(order, [1, 2, 3]);
  h2.release();
  h3.release();
});

test('release frees the next waiter in FIFO order', async () => {
  const b = new TabBudget();
  b.setMax(1);
  const h1 = await b.acquire();
  const p2 = b.acquire();
  const p3 = b.acquire();
  let tick = 0;
  let secondAt = 0;
  let thirdAt = 0;
  void p2.then(() => {
    secondAt = ++tick;
  });
  void p3.then(() => {
    thirdAt = ++tick;
  });
  h1.release();
  const h2 = await p2;
  assert.equal(secondAt > 0, true);
  assert.equal(thirdAt, 0);
  h2.release();
  const h3 = await p3;
  assert.equal(thirdAt > secondAt, true);
  h3.release();
});

test('timeout rejects with code tabSlotTimeout', async () => {
  const b = new TabBudget();
  b.setMax(1);
  const hold = await b.acquire();
  await assert.rejects(
    b.acquire({ timeoutMs: 30 }),
    (err) => err && typeof err === 'object' && err.code === 'tabSlotTimeout',
  );
  hold.release();
});

test('cancelToken aborts a queued acquire without affecting the running ones', async () => {
  const b = new TabBudget();
  b.setMax(1);
  const hold = await b.acquire();
  const ac = new AbortController();
  const pWait = b.acquire({ cancelToken: ac.signal });
  const pErr = assert.rejects(pWait, (e) => e && e.name === 'AbortError');
  ac.abort();
  await pErr;
  assert.equal(b.queueLength(), 0);
  const h2Promise = b.acquire();
  hold.release();
  const h2 = await h2Promise;
  h2.release();
});

test('setMax shrinking does not preempt running acquires but blocks new ones until releases bring count below new max', async () => {
  const b = new TabBudget();
  b.setMax(2);
  const h1 = await b.acquire();
  const h2 = await b.acquire();
  b.setMax(1);
  const stalled = b.acquire({ timeoutMs: 40 });
  await assert.rejects(
    stalled,
    (err) => err && typeof err === 'object' && err.code === 'tabSlotTimeout',
  );
  h1.release();
  const stalled2 = b.acquire({ timeoutMs: 40 });
  await assert.rejects(
    stalled2,
    (err) => err && typeof err === 'object' && err.code === 'tabSlotTimeout',
  );
  h2.release();
  const h3 = await b.acquire({ timeoutMs: 500 });
  h3.release();
});
