// All mailboxes: every mailbox as one list, while every read, reply, draft, move
// and delete still goes to the mailbox the message sits in. Message numbers
// collide on purpose (each mailbox has a uid 1).
const {chromium}=require(process.env.SIMPLEMAIL_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const page_url=require('node:url').pathToFileURL(require('node:path').join(__dirname,'../web/index.html')).href;

function fixture({allMailboxes=false, single=false}={}) {
  return {allMailboxes, single};
}

async function open(browser, options) {
  const page=await browser.newPage({viewport:{width:1300,height:850}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',dialog=>dialog.accept());
  await page.addInitScript(options=>{
    const accounts=[
      {id:'hello',label:'Extra Life Records',identity:'hello@extraliferecords.com',color:'#e11d48',signature:'ELR signature'},
      {id:'live',label:'denbyadam@live.co.uk',identity:'denbyadam@live.co.uk',color:'#0a64d6',auth:'microsoft',signature:'Live signature'},
      {id:'cloud:robots',label:'hello@meandtherobots.com',identity:'hello@meandtherobots.com',provider:'cloud',color:'#2563eb',signature:'Robots signature'},
    ].slice(0, options.single ? 1 : 3);
    accounts.forEach(account=>{account.email=account.identity;});
    const folders={
      hello:[['inbox','Inbox','INBOX',2],['sent','Sent','Sent'],['drafts','Drafts','Drafts'],['junk','Junk','Junk'],['trash','Trash','Trash'],['shop-orders','Shop Orders','Shop Orders']],
      live:[['inbox','Inbox','Inbox',1],['sent','Sent','Sent'],['drafts','Drafts',null],['junk','Junk','Junk'],['trash','Trash','Deleted']],
      'cloud:robots':[['inbox','Inbox','Inbox',0],['sent','Sent','Sent'],['drafts','Drafts','Drafts'],['junk','Junk','Junk'],['trash','Trash','Trash'],['Shop Orders','Shop Orders','Shop Orders']],
    };
    const mail={
      'hello|INBOX':[{uid:'2',subject:'ELR newest',date:'Sat, 31 Oct 2026 09:00:00 +0000',seen:false},{uid:'1',subject:'ELR old',date:'Thu, 01 Oct 2026 09:00:00 +0000',seen:false}],
      'live|Inbox':[{uid:'1',subject:'Live middle',date:'Tue, 20 Oct 2026 09:00:00 +0000',seen:false},{uid:'2',subject:'Live oldest',date:'Tue, 01 Sep 2026 09:00:00 +0000',seen:true}],
      'cloud:robots|Inbox':[{uid:'1',subject:'Robots second',date:'2026-10-25T09:00:00Z',seen:false}],
      'hello|Sent':[{uid:'1',subject:'ELR sent',date:'2026-10-02T09:00:00Z',seen:true}],
      'cloud:robots|Sent':[{uid:'7',subject:'Robots sent',date:'2026-10-03T09:00:00Z',seen:true}],
    };
    window.calls={};
    const record=(name,args)=>{(calls[name]=calls[name]||[]).push(args);};
    let releaseLive;window.liveInbox=new Promise(resolve=>{releaseLive=resolve;});window.releaseLive=releaseLive;
    window.pywebview={api:{
      get_config:async()=>({accounts,active_account:'hello',all_mailboxes:options.allMailboxes,cloud_configured:true}),
      set_active_account:async(...args)=>{record('set_active_account',args);return {ok:true};},
      check_update:async()=>({available:false}),
      get_folders:async(id)=>({folders:folders[id].map(([key,name,server,unread])=>({key,name,server,unread:unread||0}))}),
      list_messages:async(id,server)=>{
        record('list_messages',[id,server]);
        if(id==='live'&&server==='Inbox') await window.liveInbox;
        if(id==='live'&&server==='Sent') throw new Error('live is offline');
        const envelopes=(mail[id+'|'+server]||[]).map(m=>({...m,sender:'Sender <sender@example.invalid>',snippet:'Preview'}));
        const unread=envelopes.filter(m=>!m.seen).length;
        return {envelopes,unread,folder_unread:unread,inbox_unread:server.toLowerCase()==='inbox'?unread:null,validity:id==='cloud:robots'?null:'77'};
      },
      list_compose_drafts:async(id)=>id==='hello'?[{id:'d-hello',account_id:'hello',revision:1,status:'pending',updated_at:'2026-10-30T10:00:00Z',
        payload:{to:'friend@example.invalid',subject:'Hello draft',body:'Draft body',body_html:'<div>Draft body</div>'}}]:[],
      get_compose_draft:async(id,draftId)=>{record('get_compose_draft',[id,draftId]);return {id:draftId,account_id:id,revision:1,status:'pending',updated_at:'2026-10-30T10:00:00Z',
        payload:{to:'friend@example.invalid',subject:'Hello draft',body:'Draft body',body_html:'<div>Draft body</div>'},attachments:[]};},
      get_message:async(id,server,uid,validity)=>{record('get_message',[id,server,uid,validity]);
        return {subject:'Read '+id+' '+uid,sender:'Sender <sender@example.invalid>',to:id,date:'Today',text:'Body '+id+':'+server+':'+uid,html:null,attachments:[]};},
      get_compose_context:async(id,server,uid,replyAll,forward,validity)=>{record('get_compose_context',[id,server,uid,validity]);
        return {to:'sender@example.invalid',subject:'Subject from '+id,text:'Quoted from '+id,sender:'Sender',date:'Today'};},
      save_compose_draft:async(...args)=>{record('save_compose_draft',args);return {id:args[1],revision:args[2]+1};},
      delete_message:async(...args)=>{record('delete_message',args);return {status:'moved'};},
      move_message:async(...args)=>{record('move_message',args);return {status:'moved'};},
      mark_all_read:async(...args)=>{record('mark_all_read',args);return {count:1};},
      search_messages:async(id,query,cursor,server)=>{record('search_messages',[id,query,cursor,server]);
        return {items:[{uid:'search:'+id,server_uid:'9',server_folder:id==='hello'?'INBOX':'Inbox',validity:'5',sender:'Finder <finder@example.invalid>',
          subject:'Found in '+id,date:id==='live'?'2026-10-29T09:00:00Z':'2026-10-28T09:00:00Z',seen:true}],next_cursor:null};},
    }};
  },options);
  await page.goto(page_url);
  return {page,errors};
}

const subjects=page=>page.locator('#msg-list .msg .subject').allTextContents();
const mailboxes=page=>page.locator('#msg-list .msg .mbox').allTextContents();
const calls=(page,name)=>page.evaluate(name=>window.calls[name]||[],name);
const last=async(page,name)=>(await calls(page,name)).at(-1);

(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const {page,errors}=await open(browser,fixture());
  await page.getByText('ELR newest',{exact:true}).waitFor();
  assert.equal(await page.locator('#accounts button').count(),3);   // the mailbox list itself is unchanged
  assert.equal(await page.locator('#msg-list .mbox').count(),0);     // one mailbox: no mailbox tags

  // Choose All mailboxes. The quick mailboxes show while the slow one is still reading.
  await page.locator('#account-switch').click();
  assert(await page.locator('#all-mail-btn').isVisible());
  assert.match(await page.locator('#all-mail-btn').innerText(),/All mailboxes/);
  await page.locator('#all-mail-btn').click();
  await page.getByText('Robots second',{exact:true}).waitFor();
  assert.deepEqual(await subjects(page),['ELR newest','Robots second','ELR old']);
  assert.match(await page.locator('#account-switch').innerText(),/All mailboxes/);
  assert.deepEqual((await calls(page,'set_active_account')).at(-1),['*all']);
  await page.evaluate(()=>window.releaseLive());
  await page.getByText('Live middle',{exact:true}).waitFor();
  assert.deepEqual(await subjects(page),['ELR newest','Robots second','Live middle','ELR old','Live oldest']);   // newest first, across mailboxes
  assert.deepEqual(await mailboxes(page),['Extra Life Records','hello@meandtherobots.com','denbyadam@live.co.uk','Extra Life Records','denbyadam@live.co.uk']);
  await page.waitForFunction(()=>document.querySelector('#inbox-btn .badge')?.textContent==='4');   // 2 + 1 + 1 unread
  for (const id of ['agent-btn','needs-you-btn','activity-btn']) assert.equal(await page.locator('#'+id).isVisible(),false);
  assert.equal((await page.locator('#folders .folder').allTextContents()).filter(name=>name.trim()==='Shop Orders').length,1);

  // Read and reply to live's message 1 (hello has a message 1 too): both go to live.
  await page.getByText('Live middle',{exact:true}).click();
  await page.getByText('Body live:Inbox:1',{exact:true}).waitFor();
  assert.deepEqual(await last(page,'get_message'),['live','Inbox','1','77']);
  assert.match(await page.locator('#read-meta').innerText(),/In:\s*denbyadam@live\.co\.uk/);
  await page.locator('#reply-btn').click();
  await page.locator('#compose-backdrop.show').waitFor();
  assert.deepEqual(await last(page,'get_compose_context'),['live','Inbox','1','77']);
  assert.match(await page.locator('#compose-from').innerText(),/denbyadam@live\.co\.uk/);
  assert.match(await page.locator('#compose-body').innerText(),/Live signature/);
  assert.doesNotMatch(await page.locator('#compose-body').innerText(),/ELR signature|Robots signature/);
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  await page.locator('#compose-backdrop').waitFor({state:'hidden'});
  assert.equal((await last(page,'save_compose_draft'))[0],'live');
  assert.equal((await calls(page,'save_compose_draft')).every(args=>args[0]==='live'),true);

  // Reply all and forward from the cloud mailbox bind to the cloud mailbox.
  await page.getByText('Robots second',{exact:true}).click();
  await page.getByText('Body cloud:robots:Inbox:1',{exact:true}).waitFor();
  await page.locator('#forward-btn').click();
  await page.locator('#compose-backdrop.show').waitFor();
  assert.equal((await last(page,'get_compose_context'))[0],'cloud:robots');
  assert.match(await page.locator('#compose-from').innerText(),/hello@meandtherobots\.com/);
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  await page.locator('#compose-backdrop').waitFor({state:'hidden'});
  assert.equal((await last(page,'save_compose_draft'))[0],'cloud:robots');

  // Move to Trash goes to the cloud mailbox's own Trash, and only that row goes.
  await page.getByText('Robots second',{exact:true}).click();
  await page.getByText('Body cloud:robots:Inbox:1',{exact:true}).waitFor();
  await page.locator('#delete-btn').click();
  await page.waitForFunction(()=>(window.calls.delete_message||[]).length===1);
  const trashed=await last(page,'delete_message');
  assert.deepEqual(trashed.slice(0,3),['cloud:robots','Inbox','1']);
  assert.equal(trashed[3]??null,null);   // cloud mail has no folder version
  await page.getByText('Robots second',{exact:true}).waitFor({state:'detached'});
  assert.deepEqual(await subjects(page),['ELR newest','Live middle','ELR old','Live oldest']);

  // Right-click: move targets are that message's own mailbox's folders.
  await page.getByText('ELR old',{exact:true}).click();
  await page.getByText('Body hello:INBOX:1',{exact:true}).waitFor();
  await page.getByText('ELR old',{exact:true}).click({button:'right'});
  await page.locator('#ctx-menu.show').waitFor();
  const targets=await page.locator('#ctx-menu [data-act="move"]').evaluateAll(items=>items.map(item=>item.dataset.target));
  assert.deepEqual(targets,['Sent','Drafts','Junk','Trash','Shop Orders']);   // never live's "Deleted"
  assert.match(await page.locator('#ctx-menu .ctx-head').innerText(),/In Extra Life Records/);
  await page.locator('#ctx-menu [data-target="Shop Orders"]').click();
  await page.waitForFunction(()=>(window.calls.move_message||[]).length===1);
  const moved=await last(page,'move_message');
  assert.deepEqual([moved[0],moved[1],moved[2],moved[3]],['hello','INBOX','1','Shop Orders']);

  // Mark all as read: every mailbox marks its own Inbox.
  await page.locator('#markall-btn').click();
  await page.waitForFunction(()=>(window.calls.mark_all_read||[]).length===3);
  assert.deepEqual((await calls(page,'mark_all_read')).sort(),[['cloud:robots','Inbox'],['hello','INBOX'],['live','Inbox']]);

  // One mailbox failing never hides the others.
  await page.locator('#folders .folder',{hasText:'Sent'}).click();
  await page.getByText('Robots sent',{exact:true}).waitFor();
  assert.deepEqual(await subjects(page),['Robots sent','ELR sent']);
  await page.waitForFunction(()=>/denbyadam@live\.co\.uk: .*offline/.test(document.getElementById('toast').textContent));

  // Drafts saved on this device reopen bound to their own mailbox.
  await page.locator('#folders .folder',{hasText:'Drafts'}).click();
  await page.getByText('Hello draft',{exact:true}).waitFor();
  // the reply and forward kept above are listed too, each under its own mailbox
  const drafts=await page.locator('#msg-list .msg').evaluateAll(rows=>rows.map(row=>
    [row.querySelector('.subject').textContent,row.querySelector('.mbox').textContent]));
  assert.deepEqual(drafts,[['Fwd: Subject from cloud:robots','hello@meandtherobots.com'],
    ['Re: Subject from live','denbyadam@live.co.uk'],['Hello draft','Extra Life Records']]);
  await page.getByText('Hello draft',{exact:true}).click();
  await page.locator('#compose-backdrop.show').waitFor();
  assert.deepEqual(await last(page,'get_compose_draft'),['hello','d-hello']);
  assert.match(await page.locator('#compose-from').innerText(),/hello@extraliferecords\.com/);
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  await page.locator('#compose-backdrop').waitFor({state:'hidden'});
  assert.equal((await last(page,'save_compose_draft'))[0],'hello');

  // New message: choose the mailbox first, then it is bound to that one.
  await page.locator('#compose-btn').click();
  await page.locator('#compose-from-menu').waitFor();
  assert.equal(await page.locator('#compose-backdrop.show').count(),0);
  assert.equal(await page.locator('#compose-from-menu button').count(),3);
  await page.locator('#compose-from-menu').getByRole('menuitem',{name:'hello@meandtherobots.com'}).click();
  await page.locator('#compose-backdrop.show').waitFor();
  assert.match(await page.locator('#compose-from').innerText(),/hello@meandtherobots\.com/);
  assert.match(await page.locator('#compose-body').innerText(),/Robots signature/);
  await page.locator('#compose-to').fill('someone@example.invalid');
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  await page.locator('#compose-backdrop').waitFor({state:'hidden'});
  assert.equal((await last(page,'save_compose_draft'))[0],'cloud:robots');
  await page.locator('#compose-btn').click(); await page.locator('#compose-from-menu').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#compose-from-menu').waitFor({state:'hidden'});

  // Search covers every mailbox; a result opens in its own mailbox.
  await page.locator('#inbox-btn').click();
  await page.getByText('ELR newest',{exact:true}).waitFor();
  await page.locator('#search-box').fill('find');
  await page.getByText('Found in cloud:robots',{exact:true}).waitFor();
  assert.deepEqual((await calls(page,'search_messages')).map(args=>args[0]).sort(),['cloud:robots','hello','live']);
  assert.deepEqual(await subjects(page),['Found in live','Found in hello','Found in cloud:robots']);
  await page.getByText('Found in hello',{exact:true}).click();
  await page.getByText('Body hello:INBOX:9',{exact:true}).waitFor();
  assert.deepEqual(await last(page,'get_message'),['hello','INBOX','9','5']);
  await page.locator('#reply-btn').click();
  await page.locator('#compose-backdrop.show').waitFor();
  assert.match(await page.locator('#compose-from').innerText(),/hello@extraliferecords\.com/);
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  await page.locator('#compose-backdrop').waitFor({state:'hidden'});
  assert.equal((await last(page,'save_compose_draft'))[0],'hello');
  await page.locator('#search-box').fill('');

  // Back to one mailbox: only its mail, no tags, and the agent tools return.
  await page.locator('#account-switch').click();
  await page.locator('#accounts').getByRole('button',{name:'denbyadam@live.co.uk',exact:true}).click();
  await page.getByText('Live oldest',{exact:true}).waitFor();
  assert.deepEqual(await subjects(page),['Live middle','Live oldest']);
  assert.equal(await page.locator('#msg-list .mbox').count(),0);
  assert.deepEqual((await calls(page,'set_active_account')).at(-1),['live']);
  assert(await page.locator('#agent-btn').isVisible());
  await page.locator('#compose-btn').click();
  await page.locator('#compose-backdrop.show').waitFor();
  assert.equal(await page.locator('#compose-from-menu').isVisible(),false);
  assert.match(await page.locator('#compose-from').innerText(),/denbyadam@live\.co\.uk/);
  await page.getByRole('button',{name:'Keep draft',exact:true}).click();
  await page.locator('#compose-backdrop').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);

  // Remembered: the app opens on All mailboxes next time.
  const again=await open(browser,fixture({allMailboxes:true}));
  await again.page.evaluate(()=>window.releaseLive());
  await again.page.getByText('Live middle',{exact:true}).waitFor();
  assert.equal(await again.page.locator('#msg-list .mbox').count(),5);
  assert.deepEqual(again.errors,[]);

  // One mailbox: no All mailboxes entry at all.
  const one=await open(browser,fixture({allMailboxes:true,single:true}));
  await one.page.getByText('ELR newest',{exact:true}).waitFor();
  assert.equal(await one.page.locator('#all-mail-btn').isVisible(),false);
  assert.equal(await one.page.locator('#msg-list .mbox').count(),0);
  assert.deepEqual(one.errors,[]);

  console.log('All mailboxes: merged newest-first list, mailbox tags, read/reply/forward/draft/move/trash/mark-read bound to each message\'s own mailbox, failing mailbox isolated, new message asks which mailbox, search across mailboxes, remembered view passed.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
