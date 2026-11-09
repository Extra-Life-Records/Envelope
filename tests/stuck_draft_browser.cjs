// The real window, end to end: a draft the AI changes, throws away or that was sent elsewhere never
// leaves the editor stuck, and mail_show says when it couldn't open what was asked.
const {chromium} = require(process.env.SIMPLEMAIL_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const accounts = [{id: 'one', label: 'Studio', identity: 'studio@example.invalid', color: '#2563eb'}];
      const draft = (id, subject) => ({account_id: 'one', id, revision: 1, status: 'pending', updated_at: '2026-11-09T09:00:00Z',
        payload: {to: 'luca@example.invalid', subject, body: 'Hi Luca', body_html: '<div>Hi Luca</div>', cc: '', bcc: '',
          in_reply_to: '', references: '', attachment_ids: []}, attachments: []});
      window.drafts = {old: draft('old', 'Old wording'), fresh: draft('fresh', 'New wording')};
      window.sent = [];
      window.failSave = false;
      window.pywebview = {api: {
        get_config: async () => ({accounts, active_account: 'one'}),
        set_active_account: async () => {}, check_update: async () => ({available: false}),
        get_folders: async () => ({folders: ['Inbox', 'Drafts', 'Sent'].map(name => ({key: name.toLowerCase(), name, server: name, unread: 0}))}),
        list_messages: async () => ({envelopes: [{uid: '1', sender: 'Luca', subject: 'Vinyl', date: '2026-11-02', seen: true}]}),
        get_message: async () => ({subject: 'Vinyl', sender: 'Luca', to: 'one', date: 'Today', text: 'Hello'}),
        // Mirrors compose_store.py: a draft that isn't pending, or that moved on, can't be saved.
        save_compose_draft: async (account, id, revision, to, subject, body, body_html, cc, bcc, in_reply_to, references, attachment_ids) => {
          if (window.failSave) throw Error('Disk unavailable');
          const current = window.drafts[id];
          if (current && current.status !== 'pending') throw Error('ValueError: Draft is unavailable for editing');
          if ((current ? current.revision : 0) !== revision) throw Error('ValueError: Draft changed in another window; reopen it before editing');
          window.drafts[id] = {account_id: account, id, revision: revision + 1, status: 'pending', updated_at: new Date().toISOString(),
            payload: {to, subject, body, body_html, cc, bcc, in_reply_to, references, attachment_ids}, attachments: []};
          return window.drafts[id];
        },
        get_compose_draft: async (account, id) => {
          if (!window.drafts[id]) throw Error('Draft not found in this mailbox');
          return JSON.parse(JSON.stringify(window.drafts[id]));
        },
        list_compose_drafts: async account => Object.values(window.drafts).filter(d => d.account_id === account && d.status === 'pending'),
        discard_compose_draft: async (account, id) => {window.drafts[id].status = 'dismissed'; return {status: 'dismissed'};},
        send_compose_draft: async (account, id) => {window.sent.push(id); window.drafts[id].status = 'sent'; return {status: 'sent', sent_as: account};},
      }};
    });
    await page.goto(require('node:url').pathToFileURL(path.join(__dirname, '../web/index.html')).href);
    await page.waitForFunction(() => state.activeAccountId === 'one' && state.messages.length > 0);
    const editor = () => page.evaluate(() => composeVisible() ? {id: composeSession.id, subject: $('compose-subject').value} : null);
    const settle = () => page.waitForFunction(() => !composeSession || !composeSession.busy);

    // The AI opens a draft, then changes it: the window reloads the new words instead of going stale.
    let screen = await page.evaluate(() => mcpShow({account: 'one', draft_id: 'old'}));
    assert.equal(screen.error, undefined);
    assert.equal(screen.draft.draft_id, 'old');
    await page.waitForFunction(() => window.drafts.old.revision === 2);   // the window saves as it opens
    await settle();
    await page.evaluate(() => { const d = window.drafts.old; d.revision += 1; d.payload.subject = 'Old wording, fixed'; });
    assert.equal((await page.evaluate(() => mcpDraftChanged('one', 'old'))).result, 'reloaded');
    assert.deepEqual(await editor(), {id: 'old', subject: 'Old wording, fixed'});
    await settle();

    // The AI throws it away: the editor closes, and the next draft opens straight away.
    await page.evaluate(() => { window.drafts.old.status = 'dismissed'; });
    assert.equal((await page.evaluate(() => mcpDraftChanged('one', 'old'))).result, 'closed');
    assert.equal(await editor(), null);
    screen = await page.evaluate(() => mcpShow({account: 'one', draft_id: 'fresh'}));
    assert.equal(screen.error, undefined);
    assert.deepEqual(await editor(), {id: 'fresh', subject: 'New wording'});
    await settle();

    // Thrown away elsewhere without the window being told: Send refuses in plain words and closes it.
    await page.evaluate(() => { window.drafts.fresh.status = 'dismissed'; });
    await page.locator('#send-btn').click();
    await page.locator('#compose-backdrop').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#toast').innerText(), 'Not sent: this draft was thrown away');
    assert.deepEqual(await page.evaluate(() => window.sent), []);

    // mail_show on a thrown-away draft says so instead of reporting the old screen.
    screen = await page.evaluate(() => mcpShow({account: 'one', draft_id: 'old'}));
    assert.equal(screen.error, 'That draft was thrown away');

    // A draft that genuinely can't save keeps its words, and mail_show says why nothing else opened.
    await page.evaluate(() => { window.drafts.third = {...window.drafts.old, id: 'third', status: 'pending', revision: 1}; });
    await page.evaluate(() => mcpShow({account: 'one', draft_id: 'third'}));
    await settle();
    await page.evaluate(() => { window.failSave = true; window.drafts.fourth = {...window.drafts.third, id: 'fourth'}; });
    screen = await page.evaluate(() => mcpShow({account: 'one', draft_id: 'fourth'}));
    assert.match(screen.error, /The draft open in the window can't be saved \(Not saved: Error: Disk unavailable\)/);
    assert.equal((await editor()).id, 'third');
    screen = await page.evaluate(() => mcpShow({account: 'one', folder: 'Drafts'}));
    assert.match(screen.error, /can't be saved/);
    await page.evaluate(() => { window.failSave = false; });
    screen = await page.evaluate(() => mcpShow({account: 'one', draft_id: 'fourth'}));
    assert.equal(screen.error, undefined);
    assert.equal((await editor()).id, 'fourth');

    assert.deepEqual(errors, []);
    console.log('stuck draft browser checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
