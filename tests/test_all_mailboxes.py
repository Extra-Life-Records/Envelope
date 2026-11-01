"""All mailboxes is remembered as a view: it never becomes an account, and the last real mailbox stays put."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import mailapp


class AllMailboxesViewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name, value in (('CONFIG_DIR', Path(self.tmp.name)), ('CONFIG_FILE', Path(self.tmp.name) / 'config.json')):
            patcher = patch.object(mailapp, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.cfg = mailapp.Config()
        self.cfg.data['accounts'] = [mailapp.normalize_account({'id': 'hello', 'email': 'hello@example.com'}),
                                     mailapp.normalize_account({'id': 'live', 'email': 'someone@live.example'})]
        self.cfg.data['active_account'] = 'live'
        self.api = mailapp.Api(self.cfg)
        self.api._cloud_accounts = lambda: type('Cloud', (), {'transport': type('T', (), {
            'cloud_config': staticmethod(lambda: {'configured': False})})()})()

    def saved(self):
        return json.loads((Path(self.tmp.name) / 'config.json').read_text(encoding='utf-8'))

    def test_choosing_all_mailboxes_keeps_the_last_real_mailbox(self):
        self.assertEqual(self.api.set_active_account(mailapp.ALL_MAILBOXES), {'ok': True})
        self.assertTrue(self.saved()['all_mailboxes'])
        self.assertEqual(self.saved()['active_account'], 'live')
        config = self.api.get_config()
        self.assertTrue(config['all_mailboxes'])
        self.assertEqual(config['active_account'], 'live')
        self.assertNotIn(mailapp.ALL_MAILBOXES, [a['id'] for a in config['accounts']])

    def test_choosing_a_mailbox_leaves_all_mailboxes(self):
        self.api.set_active_account(mailapp.ALL_MAILBOXES)
        self.api.set_active_account('hello')
        self.assertFalse(self.saved()['all_mailboxes'])
        self.assertEqual(self.saved()['active_account'], 'hello')
        self.assertFalse(self.api.get_config()['all_mailboxes'])

    def test_unknown_mailbox_is_still_refused(self):
        with self.assertRaises(KeyError):
            self.api.set_active_account('*everything')
        self.assertEqual(self.cfg.data['active_account'], 'live')

    def test_all_mailboxes_never_resolves_to_a_mailbox(self):
        with self.assertRaises(KeyError):
            self.api._acct(mailapp.ALL_MAILBOXES)
        with self.assertRaises(KeyError):
            self.api.list_messages(mailapp.ALL_MAILBOXES, 'INBOX')

    def test_settings_saved_from_all_mailboxes_keep_the_last_real_mailbox(self):
        self.api.set_active_account(mailapp.ALL_MAILBOXES)
        config = self.api.get_config()
        config['active_account'] = mailapp.ALL_MAILBOXES   # what the window sends while on All mailboxes
        self.assertEqual(self.api.save_config(config)['active_account'], 'live')
        self.assertEqual(self.saved()['active_account'], 'live')
        self.assertTrue(self.saved()['all_mailboxes'])

    def test_older_config_opens_on_one_mailbox(self):
        self.cfg.data.pop('all_mailboxes', None)
        self.assertFalse(self.api.get_config()['all_mailboxes'])


if __name__ == '__main__':
    unittest.main()
