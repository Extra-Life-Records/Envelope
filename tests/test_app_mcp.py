"""The app's own MCP tools (app_mcp.py): JSON-RPC, the local HTTP endpoint, the tools over a fake Api
and the stdio bridge. Nothing here touches a real mailbox, window or the owner's settings."""
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app_mcp
from app_mcp import AppTools, Bridge, Endpoint, handle, serve, TOOLS
from mailbox_agent import pack, unpack

IMAP_ACCT = {"id": "denby", "label": "Denby", "email": "denby@example.com", "identity": "denby@example.com",
             "auth": "password", "signature": "Adam\nME & The Robots", "rules": {"shop.com": "Promotions"}}
CLOUD_ACCT = {"id": "cloud:adam", "label": "adam@extraliferecords.com", "email": "adam@extraliferecords.com",
              "identity": "adam@extraliferecords.com", "provider": "cloud", "signature": ""}


class FakeCloud:
    def __init__(self):
        self.patches = []
        self.moves = []
        self.rows = [
            {"id": "m3", "folder": "Inbox", "sender": "a@x.com", "subject": "Three", "seen": False, "date": "3"},
            {"id": "m2", "folder": "Sent", "sender": "adam@extraliferecords.com", "subject": "Two", "seen": True},
            {"id": "m1", "folder": "Inbox", "sender": "b@x.com", "subject": "One", "seen": True, "date": "1"},
        ]

    @staticmethod
    def mid(uid):
        return "/messages/" + uid

    def get_folders(self, account):
        return {"folders": [{"key": f.lower(), "name": f, "server": f, "unread": 0}
                            for f in ("Inbox", "Sent", "Drafts", "Junk", "Trash")], "error": None}

    def request(self, account, method, path="", data=None):
        if method == "PATCH":
            self.patches.append((path, data))
            return {}
        if path.startswith("/messages?"):
            from urllib.parse import parse_qs
            query = parse_qs(path.split("?", 1)[1])
            folder = query["folder"][0]
            rows = [r for r in self.rows if folder == "All" or r["folder"] == folder]
            if "q" in query:
                rows = [r for r in rows if query["q"][0].lower() in r["subject"].lower()]
            return {"messages": rows, "cursor": None}
        if path == "/messages/m3":
            return {**self.rows[0], "body": "Hello from the cloud " * 3, "to": "adam@extraliferecords.com",
                    "attachments": [{"part": 2, "name": "a.pdf", "size": 10}]}
        raise AssertionError(path)

    def move_message(self, account, folder, uid, target, sender="", learn=False, validity=None):
        self.moves.append((account, folder, uid, target))
        return {"status": "moved"}


class FakeApi:
    def __init__(self):
        self.cfg = Mock()
        self.cloud = FakeCloud()
        self.calls = []
        self.drafts = {}

    def _acct(self, account_id):
        if account_id == "denby":
            return IMAP_ACCT
        if account_id == "cloud:adam":
            return CLOUD_ACCT
        raise KeyError("Mailbox is not available to this sign-in")

    def _cloud_accounts(self):
        return self.cloud

    def _agent_store(self):
        return Mock()

    def _filing_store(self):
        return "filing-store"

    def get_config(self):
        return {"accounts": [dict(IMAP_ACCT), dict(CLOUD_ACCT)], "active_account": "denby", "version": "9.9.9",
                "cloud_error": None}

    def get_folders(self, account_id):
        return {"folders": [{"key": "inbox", "name": "Inbox", "server": "INBOX", "unread": 4},
                            {"key": "drafts", "name": "Drafts", "server": None, "unread": 0}], "error": None}

    def set_seen(self, *args):
        self.calls.append(("set_seen",) + args)

    def get_compose_context(self, account_id, folder, uid, reply_all=False, forward=False, validity=None):
        self.calls.append(("context", account_id, folder, uid, reply_all, forward, validity))
        return {"to": "Person <person@example.com>", "cc": "", "in_reply_to": "<orig@example.com>",
                "references": "<earlier@example.com> <orig@example.com>", "subject": "Gig on Friday",
                "sender": "Person <person@example.com>", "date": "Fri, 1 Nov 2026", "text": "Can you play <b>?",
                "attachments": [{"id": "att-1"}] if forward else []}

    def save_compose_draft(self, account_id, draft_id, revision, to, subject, body, body_html, cc="", bcc="",
                           in_reply_to="", references="", attachment_ids=None):
        current = self.drafts.get(draft_id)
        if (current["revision"] if current else 0) != revision:
            raise ValueError("Draft changed")
        draft = {"id": draft_id, "revision": revision + 1, "status": "pending", "updated_at": "now",
                 "payload": {"to": to, "subject": subject, "body": body, "body_html": body_html, "cc": cc,
                             "bcc": bcc, "in_reply_to": in_reply_to, "references": references,
                             "attachment_ids": attachment_ids or []}}
        self.drafts[draft_id] = draft
        return draft

    def get_compose_draft(self, account_id, draft_id):
        return json.loads(json.dumps(self.drafts[draft_id]))

    def list_compose_drafts(self, account_id):
        return list(self.drafts.values())

    def send_compose_draft(self, account_id, draft_id, revision):
        self.calls.append(("send", account_id, draft_id, revision))
        return {"status": "sent", "sent_as": "denby@example.com"}


class FakeMailbox:
    """Stands in for MailboxAgent(owner_access=True)."""
    def __init__(self, account="denby"):
        self.account = account
        self.searches = []

    def folders(self):
        return {"folders": ["INBOX", "Sent Messages", "Junk", "Trash", "Promotions"]}

    def ref(self, folder, uid):
        return pack({"account": self.account, "folder": folder, "validity": "7", "uid": str(uid)})

    def search(self, folder="INBOX", query="", cursor=None, limit=25, header_id=None, unseen=False):
        self.searches.append((folder, query, cursor, limit, unseen))
        items = [{"message_ref": self.ref(folder, 9), "uid": "9", "sender": "Fan <fan@example.com>",
                  "to": "denby@example.com", "subject": "Love the record", "date": "Sat", "seen": False}]
        return {"items": items, "total_matches": 1, "next_cursor": None}

    def search_all(self, query="", cursor=None, limit=25, include_junk_trash=False, header_id=None):
        self.searches.append(("*", query, cursor, limit, include_junk_trash))
        if cursor is None:
            return {"items": [{"folder": "INBOX", "message_ref": self.ref("INBOX", 5), "sender": "x@y.com",
                               "subject": "Invoice 1"}], "next_cursor": "more-please"}
        return {"items": [{"folder": "Sent Messages", "message_ref": self.ref("Sent Messages", 2),
                           "sender": "denby@example.com", "subject": "Invoice 2"}], "next_cursor": None}

    def read(self, message_ref, max_chars=20000):
        return {"message_ref": message_ref, "sender": "Fan <fan@example.com>", "to": "denby@example.com",
                "subject": "Love the record", "text": "Hi!", "truncated": False, "total_chars": 3,
                "attachments": [], "untrusted_content": True}


def call(tools, name, **arguments):
    return handle(tools, {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                          "params": {"name": name, "arguments": arguments}}, "9.9.9")["result"]


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tools = AppTools(FakeApi())

    def test_initialize_names_the_server_and_says_how_to_use_it(self):
        reply = handle(self.tools, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                    "params": {"protocolVersion": "2025-03-26"}}, "9.9.9")
        result = reply["result"]
        self.assertEqual(result["protocolVersion"], "2025-03-26")
        self.assertEqual(result["serverInfo"], {"name": "simplemail", "version": "9.9.9"})
        self.assertIn("never desktop control", result["instructions"])
        self.assertIn("untrusted data", result["instructions"])

    def test_stateless_tool_list_and_notifications(self):
        # No initialize first: several sessions share one app.
        reply = handle(self.tools, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, "9.9.9")
        names = [item["name"] for item in reply["result"]["tools"]]
        self.assertIn("mail_send", names)
        self.assertIn("mail_show", names)
        self.assertEqual(len(names), len(set(names)))
        self.assertIsNone(handle(self.tools, {"jsonrpc": "2.0", "method": "notifications/initialized"}, "9"))

    def test_every_tool_has_a_method_and_send_is_marked_outward(self):
        for item in TOOLS:
            self.assertTrue(callable(getattr(AppTools, item["name"][len("mail_"):], None)), item["name"])
        send = next(item for item in TOOLS if item["name"] == "mail_send")
        self.assertTrue(send["annotations"]["destructiveHint"])
        self.assertFalse(next(i for i in TOOLS if i["name"] == "mail_read")["annotations"]["destructiveHint"])

    def test_bad_arguments_are_refused_before_anything_runs(self):
        bad = handle(self.tools, {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                  "params": {"name": "mail_list", "arguments": {"account": "denby", "limit": 99}}}, "9")
        self.assertEqual(bad["error"]["code"], -32602)
        unknown = handle(self.tools, {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                                      "params": {"name": "mail_delete_forever", "arguments": {}}}, "9")
        self.assertEqual(unknown["error"]["code"], -32602)
        extra = handle(self.tools, {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                                    "params": {"name": "mail_accounts", "arguments": {"password": "x"}}}, "9")
        self.assertIn("Unknown argument", extra["error"]["message"])

    def test_tool_errors_come_back_as_tool_results(self):
        result = call(self.tools, "mail_folders", account="nobody")
        self.assertTrue(result["isError"])
        self.assertIn("mail_accounts lists them", result["content"][0]["text"])


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        self.tools = AppTools(self.api)
        self.mailbox = FakeMailbox()
        patcher = patch.object(AppTools, "_mailbox", lambda tools, account: self.mailbox)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_accounts_say_kind_and_which_is_open(self):
        boxes = self.tools.accounts()["mailboxes"]
        self.assertEqual([(b["id"], b["kind"], b["open_in_window"]) for b in boxes],
                         [("denby", "imap", True), ("cloud:adam", "cloud", False)])
        self.assertNotIn("password", json.dumps(boxes))

    def test_list_reads_without_marking_and_resolves_folder_names(self):
        page = self.tools.list("denby", "sent")
        self.assertEqual(self.mailbox.searches[-1], ("Sent Messages", "", None, 25, False))
        self.assertEqual(page["folder"], "Sent Messages")
        self.assertEqual(page["items"][0]["from"], "Fan <fan@example.com>")
        with self.assertRaisesRegex(ValueError, "no folder called"):
            self.tools.list("denby", "Nowhere")

    def test_cloud_list_and_read_leave_mail_unread(self):
        page = self.tools.list("cloud:adam", "Inbox")
        self.assertEqual([item["subject"] for item in page["items"]], ["Three", "One"])
        message = self.tools.read(page["items"][0]["message_ref"], max_chars=100)
        self.assertEqual(message["attachments"][0]["part_index"], 2)
        self.assertEqual(self.api.cloud.patches, [])
        self.tools.read(page["items"][0]["message_ref"], mark_read=True)
        self.assertEqual(self.api.calls[-1][:4], ("set_seen", "cloud:adam", "Inbox", "m3"))

    def test_unread_covers_every_mailbox_and_survives_one_failing(self):
        def broken(folder="INBOX", query="", cursor=None, limit=25, header_id=None, unseen=False):
            raise OSError("IMAP down")
        self.mailbox.search = broken
        boxes = {box["account"]: box for box in self.tools.unread()["mailboxes"]}
        self.assertIn("IMAP down", boxes["denby"]["error"])
        self.assertEqual([i["subject"] for i in boxes["cloud:adam"]["items"]], ["Three"])

    def test_search_every_mailbox_follows_one_cursor_across_them(self):
        first = self.tools.search("invoice")
        self.assertEqual([i["subject"] for i in first["items"]], ["Invoice 1"])
        self.assertTrue(first["next_cursor"])
        second = self.tools.search("invoice", cursor=first["next_cursor"])
        self.assertEqual([i["subject"] for i in second["items"]], ["Invoice 2"])
        third = self.tools.search("invoice", cursor=second["next_cursor"]) if second["next_cursor"] else {"items": []}
        seen = [i["subject"] for i in first["items"] + second["items"] + third["items"]]
        self.assertEqual(seen, ["Invoice 1", "Invoice 2"])   # the cloud has no invoice
        with self.assertRaisesRegex(ValueError, "another search"):
            self.tools.search("other", cursor=first["next_cursor"])

    def test_moves_are_batched_recoverable_and_per_mailbox(self):
        refs = [self.mailbox.ref("INBOX", 5), self.mailbox.ref("INBOX", 6),
                pack({"account": "cloud:adam", "folder": "Inbox", "validity": None, "uid": "m3"})]
        with patch("mail_filing.move_many", return_value={"moved": 2, "uncertain": 0, "missing": 0,
                                                          "moved_uids": ["5", "6"]}) as many:
            result = self.tools.move(refs, "Promotions", reason="Sorted: promotions")
        args, kwargs = many.call_args
        self.assertEqual(args[0]["id"], "denby")
        self.assertEqual((args[2], args[3], args[4], args[6]), ("INBOX", ["5", "6"], "Promotions", "7"))
        self.assertEqual(kwargs["actor"], "agent")
        self.assertEqual(result["results"][1]["error"], "cloud:adam has no folder called 'Promotions': "
                                                        "mail_folders lists them")
        self.assertEqual(result["moved"], 2)
        trashed = self.tools.trash([refs[2]])
        self.assertEqual(self.api.cloud.moves, [("cloud:adam", "Inbox", "m3", "Trash")])
        self.assertEqual(trashed["moved"], 1)

    def test_reply_draft_comes_from_the_emails_mailbox_with_quote_signature_and_threading(self):
        ref = self.mailbox.ref("INBOX", 9)
        with self.assertRaisesRegex(ValueError, "mailbox the email is in"):
            self.tools.draft(account="cloud:adam", reply_to=ref, body="Hi")
        draft = self.tools.draft(reply_to=ref, body="Yes, see you there.\n\nAdam")
        saved = self.api.drafts[draft["draft_id"]]["payload"]
        self.assertEqual(draft["account"], "denby")
        self.assertEqual(saved["subject"], "Re: Gig on Friday")
        self.assertEqual(saved["to"], "Person <person@example.com>")
        self.assertEqual(saved["in_reply_to"], "<orig@example.com>")
        self.assertTrue(saved["body"].startswith("Yes, see you there.\n\nAdam\n\nAdam\nME & The Robots"))
        self.assertIn("On Fri, 1 Nov 2026, Person wrote:\nCan you play <b>?", saved["body"])
        self.assertIn("<div>Yes, see you there.</div><div><br></div><div>Adam</div>", saved["body_html"])
        self.assertIn("Adam<br>ME &amp; The Robots", saved["body_html"].replace("ME & The", "ME &amp; The"))
        self.assertIn("Can you play &lt;b&gt;?", saved["body_html"])   # quoted mail is escaped, never markup
        self.assertFalse(draft["sent"])

        changed = self.tools.draft(account="denby", draft_id=draft["draft_id"], revision=draft["revision"],
                                   body="Sorry, can't make it.")
        saved = self.api.drafts[draft["draft_id"]]["payload"]
        self.assertEqual(changed["revision"], 2)
        self.assertTrue(saved["body"].startswith("Sorry, can't make it."))
        self.assertIn("Person wrote:\nCan you play <b>?", saved["body"])
        self.assertIn("<blockquote>", saved["body_html"])
        self.assertNotIn("see you there", saved["body"] + saved["body_html"])
        with self.assertRaisesRegex(ValueError, "keeps the reply"):
            self.tools.draft(draft_id=draft["draft_id"], revision=2, reply_to=ref)

    def test_forward_keeps_files_and_new_mail_needs_an_account(self):
        draft = self.tools.draft(forward=self.mailbox.ref("INBOX", 9), to="band@example.com")
        saved = self.api.drafts[draft["draft_id"]]["payload"]
        self.assertEqual((saved["subject"], saved["to"], saved["attachment_ids"]),
                         ("Fwd: Gig on Friday", "band@example.com", ["att-1"]))
        with self.assertRaisesRegex(ValueError, "Give account"):
            self.tools.draft(to="x@example.com", body="Hi")

    def test_send_is_a_separate_exact_revision_step(self):
        draft = self.tools.draft(account="denby", to="x@example.com", subject="Hi", body="Hello")
        self.assertFalse(any(c[0] == "send" for c in self.api.calls))
        self.tools.send("denby", draft["draft_id"], draft["revision"])
        self.assertEqual(self.api.calls[-1], ("send", "denby", draft["draft_id"], 1))

    def test_show_and_screen_drive_the_window_through_mcp_js(self):
        window = Mock()
        scripts = []

        def evaluate_js(script, callback=None):
            scripts.append(script)
            if callback:
                callback({"account": {"id": "denby"}, "messages": [
                    {"uid": "9", "server_folder": "INBOX", "validity": "7", "subject": "Love the record"},
                    {"uid": None, "draft_id": "d1", "server_folder": "INBOX", "validity": "7"}],
                    "open_message": None})
        window.evaluate_js.side_effect = evaluate_js
        self.tools.window = window
        screen = self.tools.show(message_ref=self.mailbox.ref("INBOX", 9))
        self.assertTrue(scripts[0].startswith("mcpShow("))
        self.assertEqual(json.loads(scripts[0][len("mcpShow("):-1]),
                         {"account": "denby", "folder": "INBOX", "uid": "9"})
        self.assertEqual(unpack(screen["messages"][0]["message_ref"])["uid"], "9")
        self.assertNotIn("message_ref", screen["messages"][1])
        self.tools.screen()
        self.assertEqual(scripts[-1], "mcpScreen()")

    def test_all_mailboxes_rows_get_refs_for_their_own_mailbox(self):
        window = Mock()
        scripts = []

        def evaluate_js(script, callback=None):
            scripts.append(script)
            callback({"account": {"id": "all", "label": "All mailboxes"}, "messages": [
                {"account": "cloud:adam", "uid": "m3", "server_folder": "Inbox", "validity": None},
                {"account": "denby", "uid": "9", "server_folder": "INBOX", "validity": "7"}]})
        window.evaluate_js.side_effect = evaluate_js
        self.tools.window = window
        screen = self.tools.show(account="all", folder="Inbox")
        self.assertEqual(json.loads(scripts[0][len("mcpShow("):-1]), {"account": "all", "folder": "Inbox"})
        refs = [unpack(item["message_ref"]) for item in screen["messages"]]
        self.assertEqual([(r["account"], r["uid"]) for r in refs], [("cloud:adam", "m3"), ("denby", "9")])
        self.assertEqual([item["account"] for item in screen["messages"]], ["cloud:adam", "denby"])

    def test_window_errors_and_missing_window_are_plain_errors(self):
        with self.assertRaisesRegex(ValueError, "window isn't open"):
            self.tools.screen()
        window = Mock()
        window.evaluate_js.side_effect = lambda script, callback=None: callback({"error": "No folder called X"})
        self.tools.window = window
        with self.assertRaisesRegex(ValueError, "No folder called X"):
            self.tools.show(account="denby")

    def test_writes_refresh_the_window_lists(self):
        window = Mock()
        self.tools.window = window
        call(self.tools, "mail_mark", message_refs=[self.mailbox.ref("INBOX", 9)], read=True)
        window.evaluate_js.assert_called_with("typeof mcpRefresh === 'function' && mcpRefresh()")

    def test_thread_of_a_non_reply_is_just_the_email_and_slow_servers_say_so(self):
        self.mailbox.thread = Mock(side_effect=AssertionError("must not search the whole mailbox"))
        page = self.tools.thread(self.mailbox.ref("INBOX", 9))
        self.assertEqual((page["linkage"], page["items"][0]["from"]), ("not_a_reply", "Fan <fan@example.com>"))
        original = self.mailbox.read
        self.mailbox.read = lambda ref, max_chars=20000: {**original(ref, max_chars), "references": "<a@b>"}
        self.mailbox.thread = Mock(side_effect=TimeoutError("cannot read from timed out object"))
        with self.assertRaisesRegex(ValueError, "took too long"):
            self.tools.thread(self.mailbox.ref("INBOX", 9))

    def test_cleanup_tools_refuse_cloud_mailboxes(self):
        with self.assertRaisesRegex(ValueError, "not cloud ones"):
            self.tools.senders("cloud:adam")
        self.assertEqual(self.tools.rules("denby")["rules"], [{"site": "shop.com", "folder": "Promotions"}])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {"APPDATA": self.temp.name})
        env.start()
        self.addCleanup(env.stop)
        import socket
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.port = probe.getsockname()[1]
        self.release = threading.Event()
        tools = Mock()

        def slow_or_fast(name, arguments):
            if name == "mail_screen":
                self.release.wait(5)
            return {"tool": name}
        tools.call.side_effect = slow_or_fast

        def static(environ, start_response):
            start_response("200 OK", [("Content-Type", "text/plain")])
            return [b"index"]
        self.httpd = serve(static, tools, self.port, "9.9.9", exe="C:\\SimpleMail.exe")
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)
        self.info = json.loads(app_mcp.discovery_file(self.port).read_text(encoding="utf-8"))

    def post(self, body, token=None, host=None):
        request = urllib.request.Request(self.info["url"], data=json.dumps(body).encode(), method="POST",
                                         headers={"Content-Type": "application/json",
                                                  "Authorization": "Bearer " + (token or self.info["token"])})
        if host:
            request.add_header("Host", host)
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read() or b"null")

    def test_discovery_file_says_where_and_the_window_still_loads(self):
        self.assertEqual(self.info["url"], f"http://127.0.0.1:{self.port}/mcp")
        self.assertGreaterEqual(len(self.info["token"]), 32)
        self.assertEqual(self.info["exe"], "C:\\SimpleMail.exe")
        self.assertTrue(app_mcp.discovery_file(self.port).name.startswith("mcp-"))
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=5) as response:
            self.assertEqual(response.read(), b"index")

    def test_token_host_and_method_are_checked(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post({"jsonrpc": "2.0", "id": 1, "method": "ping"}, token="wrong" * 10)
        self.assertEqual(caught.exception.code, 401)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post({"jsonrpc": "2.0", "id": 1, "method": "ping"}, host="evil.example:80")
        self.assertEqual(caught.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(urllib.request.Request(self.info["url"], headers={
                "Authorization": "Bearer " + self.info["token"]}), timeout=5)
        self.assertEqual(caught.exception.code, 405)
        status, reply = self.post({"jsonrpc": "2.0", "id": 7, "method": "initialize",
                                   "params": {"protocolVersion": "2025-06-18"}})
        self.assertEqual((status, reply["id"], reply["result"]["serverInfo"]["name"]), (200, 7, "simplemail"))
        status, _ = self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(status, 202)

    def test_token_survives_a_restart_and_a_taken_port_is_left_alone(self):
        again = Mock()
        self.assertIsNone(serve(lambda e, s: [], again, self.port, "9.9.9"))   # this port is in use
        self.assertEqual(app_mcp.load_token(app_mcp.discovery_file(self.port)), self.info["token"])

    def test_a_slow_tool_never_holds_up_another_session(self):
        slow = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "mail_screen", "arguments": {}}}
        fast = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "mail_accounts", "arguments": {}}}
        worker = threading.Thread(target=lambda: self.post(slow))
        worker.start()
        time.sleep(0.2)
        started = time.monotonic()
        status, reply = self.post(fast)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(reply["result"]["structuredContent"], {"tool": "mail_accounts"})
        self.release.set()
        worker.join(5)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {"APPDATA": self.temp.name})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("SIMPLEMAIL_PORT", None)

    def run_bridge(self, bridge, *requests):
        out = io.StringIO()
        bridge.serve(io.StringIO("".join(json.dumps(r) + "\n" for r in requests)), out)
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_handshake_and_tool_list_need_no_app(self):
        post = Mock(side_effect=AssertionError("must not contact the app"))
        launch = Mock()
        replies = self.run_bridge(Bridge("9.9.9", post=post, launch=launch, running=lambda: False),
                                  {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                   "params": {"protocolVersion": "2025-06-18"}},
                                  {"jsonrpc": "2.0", "method": "notifications/initialized"},
                                  {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(replies[0]["result"]["serverInfo"]["name"], "simplemail")
        self.assertEqual(len(replies[1]["result"]["tools"]), len(TOOLS))
        post.assert_not_called()
        launch.assert_not_called()

    def test_tool_call_opens_simplemail_once_then_forwards(self):
        answers = [ConnectionRefusedError(), ConnectionRefusedError(),
                   (200, json.dumps({"jsonrpc": "2.0", "id": 3, "result": {"ok": True}}).encode())]

        def post(url, token, body, timeout):
            self.assertEqual(json.loads(body)["params"]["name"], "mail_accounts")
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        launch = Mock()
        with patch("time.sleep"):
            replies = self.run_bridge(Bridge("9.9.9", post=post, launch=launch, running=lambda: False),
                                      {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                       "params": {"name": "mail_accounts", "arguments": {}}})
        self.assertEqual(replies, [{"jsonrpc": "2.0", "id": 3, "result": {"ok": True}}])
        launch.assert_called_once()

    def test_an_app_already_starting_is_waited_for_not_opened_twice(self):
        answers = [ConnectionRefusedError(), (200, b'{"jsonrpc": "2.0", "id": 4, "result": {}}')]

        def post(url, token, body, timeout):
            answer = answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        launch = Mock()
        with patch("time.sleep"):
            self.run_bridge(Bridge("9", post=post, launch=launch, running=lambda: True),
                            {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                             "params": {"name": "mail_screen", "arguments": {}}})
        launch.assert_not_called()

    def test_an_older_open_app_says_restart(self):
        def post(url, token, body, timeout):
            raise urllib.error.HTTPError(url, 405, "Method Not Allowed", {}, None)
        replies = self.run_bridge(Bridge("9", post=post, launch=Mock(), running=lambda: True),
                                  {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                                   "params": {"name": "mail_accounts", "arguments": {}}})
        self.assertTrue(replies[0]["result"]["isError"])
        self.assertIn("restart Envelope", replies[0]["result"]["content"][0]["text"])

    def test_dev_port_never_opens_the_installed_app(self):
        launch = Mock()
        replies = self.run_bridge(Bridge("9", port=17600, post=Mock(side_effect=ConnectionRefusedError()),
                                         launch=launch, running=lambda: False),
                                  {"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                                   "params": {"name": "mail_accounts", "arguments": {}}})
        self.assertIn("port 17600", replies[0]["result"]["content"][0]["text"])
        launch.assert_not_called()

    def test_bridge_uses_the_token_the_app_published(self):
        app_mcp.publish(app_mcp.discovery_file(), 17591, "t" * 40, "9")
        seen = {}

        def post(url, token, body, timeout):
            seen.update(url=url, token=token)
            return 200, b'{"jsonrpc": "2.0", "id": 8, "result": {}}'
        self.run_bridge(Bridge("9", post=post, launch=Mock(), running=lambda: True),
                        {"jsonrpc": "2.0", "id": 8, "method": "tools/call",
                         "params": {"name": "mail_accounts", "arguments": {}}})
        self.assertEqual(seen, {"url": "http://127.0.0.1:17591/mcp", "token": "t" * 40})


class AgentEntryTests(unittest.TestCase):
    def test_agent_app_command_runs_the_bridge(self):
        import agent_mcp
        with patch("app_mcp.bridge_main", return_value=0) as bridge:
            self.assertEqual(agent_mcp.main(["app"]), 0)
        bridge.assert_called_once()


if __name__ == "__main__":
    unittest.main()
