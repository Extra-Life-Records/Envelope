// A draft the AI (or another window) changed, sent or threw away must never leave the window stuck
// on an editor that can't save, and mail_show must say when it couldn't open what was asked.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const compose = fs.readFileSync(path.join(__dirname, '../web/compose.js'), 'utf8');
const mcp = fs.readFileSync(path.join(__dirname, '../web/mcp.js'), 'utf8');

function element() {
  const classes = new Set();
  return {value: '', textContent: '', contentEditable: 'true', addEventListener() {}, focus() {},
    classList: {add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c)}};
}

function app({open = 'd1', revision = 2} = {}) {
  const elements = new Map();
  const cache = new Map();
  const toasts = [];
  const context = vm.createContext({
    console, crypto: {randomUUID: () => 'new-id'}, setTimeout: () => 1, clearTimeout() {}, setImmediate,
    localStorage: {setItem: (key, value) => cache.set(key, value), getItem: key => cache.get(key),
      removeItem: key => cache.delete(key), key: n => [...cache.keys()][n], get length() { return cache.size; }},
    $: id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    document: {querySelectorAll: () => []},
    composeText: () => elements.get('compose-body')?.value || '',
    composeHtml: () => elements.get('compose-body')?.value || '',
    state: {currentFolder: 'inbox', activeAccountId: 'one', accounts: [{id: 'one'}]},
    api: {}, toast: (message, isError) => toasts.push({message, isError}), loadMessages() {},
  });
  const run = code => vm.runInContext(code, context);
  run(compose);
  if (open) {
    run(`startComposeSession('one', {id: '${open}', revision: ${revision}, payload: {in_reply_to: ''}})`);
    run("$('compose-body').value = 'Hello Luca'; $('compose-backdrop').classList.add('show'); composeChanged()");
    run('composeSession.savedGeneration = composeSession.generation');   // as if autosave caught up
  }
  return {run, context, cache, toasts, api: run('api'), visible: () => run('composeVisible()')};
}

test('the AI throwing away the open draft closes it and forgets its recovery copy', async () => {
  const a = app();
  assert.equal(a.cache.size, 1);
  a.api.get_compose_draft = async () => ({status: 'dismissed', revision: 2});
  assert.equal(await a.run("draftChangedElsewhere('one', 'd1')"), 'closed');
  assert.equal(a.visible(), false);
  assert.equal(a.cache.size, 0);
  assert.match(a.toasts.at(-1).message, /thrown away/);
});

test('the AI changing the open draft reloads it when nothing typed is unsaved', async () => {
  const a = app();
  const reopened = [];
  a.api.get_compose_draft = async () => ({status: 'pending', revision: 3});
  a.context.resumeComposeDraft = async (...args) => { reopened.push(args); };
  assert.equal(await a.run("draftChangedElsewhere('one', 'd1')"), 'reloaded');
  assert.deepEqual(reopened, [['d1', 'one']]);
  assert.equal(a.cache.size, 0);   // the stale snapshot can't win over the AI's newer words
});

test('unsaved typing stays put when the AI changes the same draft', async () => {
  const a = app();
  a.run("$('compose-body').value = 'Hello Luca, one more thing'; composeChanged()");
  a.api.get_compose_draft = async () => ({status: 'pending', revision: 3});
  a.context.resumeComposeDraft = async () => { throw Error('must not reload over unsaved typing'); };
  assert.equal(await a.run("draftChangedElsewhere('one', 'd1')"), 'kept');
  assert.equal(a.visible(), true);
  assert.match(a.run("$('compose-save-status').textContent"), /Changed outside this window/);
});

test('a different open draft is left alone, but a thrown-away one stops coming back from recovery', async () => {
  const a = app({open: 'd2'});
  a.cache.set('simplemail-compose:one:d1', '{}');
  a.api.get_compose_draft = async () => ({status: 'dismissed', revision: 4});
  assert.equal(await a.run("draftChangedElsewhere('one', 'd1')"), 'not open');
  assert.equal(a.visible(), true);
  assert.equal(a.cache.has('simplemail-compose:one:d1'), false);
  assert.equal(a.cache.has('simplemail-compose:one:d2'), true);
});

test('Keep draft on a draft thrown away elsewhere closes it instead of blocking forever', async () => {
  const a = app();
  a.api.save_compose_draft = async () => { throw Error('ValueError: Draft is unavailable for editing'); };
  a.api.get_compose_draft = async () => ({status: 'dismissed', revision: 2});
  assert.equal(await a.run('closeCompose()'), true);
  assert.equal(a.visible(), false);
  assert.match(a.toasts.at(-1).message, /thrown away, so it was closed/);
});

test('an ordinary save failure still keeps the editor and its words', async () => {
  const a = app();
  a.api.save_compose_draft = async () => { throw Error('Disk unavailable'); };
  a.api.get_compose_draft = async () => ({status: 'pending', revision: 2});
  assert.equal(await a.run('closeCompose()'), false);
  assert.equal(a.visible(), true);
  assert.equal(a.cache.size, 1);
  assert.match(a.toasts.at(-1).message, /Keep this draft open/);
});

test('Discard on a copy changed elsewhere closes it and keeps the typing for Drafts', async () => {
  const a = app();
  a.api.save_compose_draft = async () => { throw Error('Draft changed in another window; reopen it before editing'); };
  a.api.get_compose_draft = async () => ({status: 'pending', revision: 5});
  a.api.discard_compose_draft = async () => { throw Error('must not discard the newer saved copy'); };
  await a.run('discardCompose()');
  assert.equal(a.visible(), false);
  assert.equal(a.cache.size, 1);
  assert.match(a.toasts.at(-1).message, /changed outside this window/);
});

test('Send on a draft that was thrown away refuses in plain words', async () => {
  const a = app();
  a.api.get_compose_draft = async () => ({status: 'dismissed', revision: 2});
  assert.equal(await a.run("closeStaleCompose(composeSession, 'send')"), true);
  assert.equal(a.visible(), false);
  assert.deepEqual(a.toasts.at(-1), {message: 'Not sent: this draft was thrown away', isError: true});
});

function window() {
  const a = app({open: 'old'});
  a.run(mcp);
  Object.assign(a.context, {ALL_MAIL: '__all__', mailSearch: false, selectAccount: async () => {},
    selectFolder: async () => {}, openMessage: async () => {}, resumeComposeDraft: async () => {}});
  a.context.state.folders = [{key: 'drafts', name: 'Drafts', server: 'Drafts'}, {key: 'inbox', name: 'Inbox', server: 'INBOX'}];
  a.run("$('compose-save-status').textContent = 'Not saved: Draft is unavailable for editing'");
  return a;
}

test('mail_show says when a stuck draft stops another draft opening', async () => {
  const a = window();
  a.api.get_compose_draft = async () => ({status: 'pending', revision: 1});
  const result = await a.run("mcpShow({account: 'one', draft_id: 'new'})");
  assert.match(result.error, /draft open in the window can't be saved \(Not saved: Draft is unavailable/);
  assert.match(result.error, /Keep draft or Discard/);
});

test('mail_show says when a stuck draft stops a folder opening', async () => {
  const a = window();
  const result = await a.run("mcpShow({account: 'one', folder: 'Drafts'})");
  assert.match(result.error, /draft open in the window can't be saved/);
});

test('mail_show says a thrown-away draft was thrown away', async () => {
  const a = window();
  a.run("$('compose-backdrop').classList.remove('show')");
  a.api.get_compose_draft = async () => ({status: 'dismissed', revision: 3});
  assert.equal((await a.run("mcpShow({account: 'one', draft_id: 'gone'})")).error, 'That draft was thrown away');
});
