/* Run with: node --test tests/test_all_mailboxes.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() { for (let i = 0; i < 20; i++) await flush(); }

function app(folders) {
  const elements = new Map();
  const element = () => ({
    innerHTML: '', textContent: '', value: '', scrollTop: 0, style: {}, dataset: {}, hidden: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, querySelectorAll: () => [], querySelector: () => null,
    setAttribute() {}, focus() {},
  });
  const context = vm.createContext({
    window: { addEventListener() {} }, URL, console,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element, createTextNode: (text) => ({ textContent: text }), querySelectorAll: () => [],
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    confirm: () => true,
  });
  const run = (js) => vm.runInContext(js, context);
  run(source);
  run(`renderMessages = () => {}; renderAccounts = () => {}; renderFolders = () => {};`);
  const api = run(`api = {
    set_active_account: async () => ({ok: true}),
    get_folders: async (id) => ({folders: JSON.parse(JSON.stringify(FOLDERS[id]))}),
    list_compose_drafts: async () => [],
  }; api`);
  context.FOLDERS = folders;
  return { run, api };
}

const IMAP = [{ key: 'inbox', name: 'Inbox', server: 'INBOX', unread: 0 }];
const env = (uid, subject, date, seen = true) => ({ uid, subject, date, seen, sender: 'S <s@example.invalid>' });
const listing = (envelopes) => ({ envelopes, unread: envelopes.filter((m) => !m.seen).length,
  folder_unread: envelopes.filter((m) => !m.seen).length, inbox_unread: null, validity: '9' });

async function allMailboxes(a, accounts) {
  a.run(`state.accounts = ${JSON.stringify(accounts)}`);
  await a.run(`selectAccount(ALL_MAIL)`);
  await settle();
}

test('folders merge by kind and keep each mailbox\'s own server names', async () => {
  const a = app({
    a: [{ key: 'inbox', name: 'Inbox', server: 'INBOX' }, { key: 'trash', name: 'Trash', server: 'Deleted Items' },
        { key: 'shop-orders', name: 'Shop Orders', server: 'Shop Orders' }],
    'cloud:b': [{ key: 'inbox', name: 'Inbox', server: 'Inbox' }, { key: 'trash', name: 'Trash', server: 'Trash' },
                { key: 'Shop Orders', name: 'Shop Orders', server: 'Shop Orders' }, { key: 'Receipts', name: 'Receipts', server: 'Receipts' }],
  });
  a.api.list_messages = async () => listing([]);
  await allMailboxes(a, [{ id: 'a' }, { id: 'cloud:b', provider: 'cloud' }]);
  const folders = JSON.parse(a.run(`JSON.stringify(state.folders.map(f => [f.key, f.server, f.members.map(m => m.accountId + ':' + m.folder.server)]))`));
  assert.deepEqual(folders, [
    ['inbox', null, ['a:INBOX', 'cloud:b:Inbox']],
    ['trash', null, ['a:Deleted Items', 'cloud:b:Trash']],
    ['shop orders', null, ['a:Shop Orders', 'cloud:b:Shop Orders']],
    ['receipts', null, ['cloud:b:Receipts']],
  ]);
  assert.equal(a.run('state.activeAccountId'), '*all');
});

test('colliding uids stay apart and the list is newest first across mailboxes', async () => {
  const a = app({ a: IMAP, b: IMAP });
  a.api.list_messages = async (id) => listing(id === 'a'
    ? [env('1', 'A new', 'Sat, 31 Oct 2026 10:00:00 +0000'), env('2', 'A old', 'Thu, 01 Oct 2026 10:00:00 +0000')]
    : [env('1', 'B mid', '2026-10-15T10:00:00Z'), env('3', 'B undated', 'not a date')]);
  await allMailboxes(a, [{ id: 'a' }, { id: 'b' }]);
  const rows = JSON.parse(a.run(`JSON.stringify(state.messages.map(m => [m.uid, m.accountId, m.server_uid, m.server_folder, m.subject]))`));
  assert.deepEqual(rows, [
    ['a|1', 'a', '1', 'INBOX', 'A new'],
    ['b|1', 'b', '1', 'INBOX', 'B mid'],
    ['a|2', 'a', '2', 'INBOX', 'A old'],
    ['b|3', 'b', '3', 'INBOX', 'B undated'],
  ]);
});

test('a click on one mailbox while it is being read re-reads just that mailbox, once', async () => {
  const a = app({ a: IMAP, b: IMAP });
  const reads = { a: 0, b: 0 };
  const slow = deferred();
  a.api.list_messages = async (id) => {
    reads[id]++;
    if (id === 'a' && reads.a === 1) return slow.promise;
    return listing([env(id === 'a' ? '1' : '5', id + ' mail ' + reads[id], '2026-10-0' + reads[id] + 'T10:00:00Z')]);
  };
  a.run(`state.accounts = [{id:'a'}, {id:'b'}]`);
  const opening = a.run(`selectAccount(ALL_MAIL)`);
  await settle();
  assert.deepEqual(reads, { a: 1, b: 1 });
  // A message from mailbox a is opened (marked read) while a's list is still on its way.
  let finishAction;
  const action = a.run(`mailAction(() => new Promise(done => { globalThis.finishAction = done; }), 'a')`);
  finishAction = a.run('finishAction');
  slow.resolve(listing([env('1', 'a mail before the click', '2026-10-01T10:00:00Z', false)]));
  await settle();
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(state.messages.map(m => m.subject))')), ['b mail 1']);
  finishAction({});
  await action; await opening; await settle();
  assert.deepEqual(reads, { a: 2, b: 1 });   // only a is read again
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(state.messages.map(m => m.subject))')), ['a mail 2', 'b mail 1']);
});

test('a background refresh waits a minute between reads; Refresh does not', async () => {
  const a = app({ a: IMAP, b: IMAP });
  let reads = 0;
  a.api.list_messages = async (id) => { reads++; return listing([env('1', id, '2026-10-01T10:00:00Z')]); };
  a.run('let clock = 1000000; Date.now = () => clock');
  await allMailboxes(a, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(reads, 2);
  await a.run('loadMessages({ quiet: true, background: true })');
  await settle();
  assert.equal(reads, 2);
  a.run('clock += 61000');
  await a.run('loadMessages({ quiet: true, background: true })');
  await settle();
  assert.equal(reads, 4);
  await a.run('loadMessages()');   // the Refresh button
  await settle();
  assert.equal(reads, 6);
});

test('one mailbox failing keeps the others and names the failing one', async () => {
  const a = app({ a: IMAP, 'cloud:b': [{ key: 'inbox', name: 'Inbox', server: 'Inbox' }] });
  a.api.list_messages = async (id) => {
    if (id === 'cloud:b') throw Error('Reconnect employee mailboxes in Settings.');
    return listing([env('1', 'still here', '2026-10-01T10:00:00Z')]);
  };
  await allMailboxes(a, [{ id: 'a', label: 'A' }, { id: 'cloud:b', label: 'B', provider: 'cloud' }]);
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(state.messages.map(m => m.subject))')), ['still here']);
  assert.match(a.run("$('toast').textContent"), /B: Error: Reconnect/);
  assert.equal(a.run("$('cloud-status').hidden"), false);
});

test('search asks every mailbox, continues each from its own place and retries only the failed one', async () => {
  const a = app({ a: IMAP, b: IMAP });
  a.api.list_messages = async () => listing([]);
  await allMailboxes(a, [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]);
  const calls = [];
  let bDown = true;
  a.api.search_messages = async (id, query, cursor) => {
    calls.push([id, cursor]);
    if (id === 'b' && bDown) throw Error('offline');
    if (id === 'a') return { items: [env('s' + (cursor || 0), 'a hit ' + (cursor || 'first'), '2026-10-0' + (cursor ? 2 : 1) + 'T10:00:00Z')],
                             next_cursor: cursor ? null : 'a2' };
    return { items: [env('s', 'b hit', '2026-10-09T10:00:00Z')], next_cursor: null };
  };
  a.run(`$('search-box').value = 'hit'; queueMailSearch()`);
  await a.run('loadSearchResults()');
  assert.deepEqual(calls, [['a', null], ['b', null], ['a', 'a2']]);   // b failed; a carried on by itself
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(state.messages.map(m => m.subject))')), ['a hit a2', 'a hit first']);
  assert.match(a.run('mailSearch.error'), /Could not search B/);
  assert.equal(a.run('mailSearch.cursor'), 'more');
  bDown = false;
  await a.run('loadSearchResults(mailSearch.retryMore)');
  assert.deepEqual(calls.slice(3), [['b', null]]);
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(state.messages.map(m => [m.subject, m.accountId]))')),
    [['b hit', 'b'], ['a hit a2', 'a'], ['a hit first', 'a']]);
  assert.equal(a.run('mailSearch.cursor'), null);
  assert.equal(a.run('mailSearch.error'), null);
});

test('replies, drafts and moves take the message\'s mailbox, never the view', async () => {
  const a = app({ a: IMAP, b: IMAP });
  a.api.list_messages = async (id) => listing([env('1', id, '2026-10-01T10:00:00Z')]);
  await allMailboxes(a, [{ id: 'a', label: 'A', identity: 'a@example.invalid' }, { id: 'b', label: 'B', identity: 'b@example.invalid' }]);
  assert.equal(a.run(`messageAccountId(state.messages.find(m => m.accountId === 'b'))`), 'b');
  assert.equal(a.run(`messageAccountId({})`), '*all');           // a row without a mailbox resolves to no mailbox
  assert.equal(a.run(`messageAccount({})`), null);
  assert.equal(a.run(`activeAccount()`), null);
});
