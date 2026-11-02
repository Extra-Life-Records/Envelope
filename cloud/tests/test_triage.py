import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
import boto3
from moto import mock_aws
sys.path.insert(0, str(Path(__file__).parents[1] / 'src'))
import service
import ai_access as access
import remote_mcp
import triage_fire


@mock_aws
class TriageTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, AWS_DEFAULT_REGION='eu-west-1', TABLE='mail', BUCKET='mail-testing', DOMAIN='extraliferecords.com', RECEIVE_DOMAIN='inbox.playloudr.com', EXTERNAL_SECRET='', MCP_CLIENT_IDS='clientA,clientB', MCP_RESOURCE='https://mail.example/mcp',
                         NOTIFY_ENABLED='true', NOTIFY_TO='adam@extraliferecords.com', NOTIFY_FROM='triage@extraliferecords.com', CONFIGURATION_SET='')
        env.start(); self.addCleanup(env.stop)
        boto3.client('dynamodb').create_table(TableName='mail', BillingMode='PAY_PER_REQUEST', AttributeDefinitions=[{'AttributeName': k, 'AttributeType': 'S'} for k in ('pk', 'sk', 'received')], KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}], GlobalSecondaryIndexes=[{'IndexName': 'Chronological', 'KeySchema': [{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'received', 'KeyType': 'RANGE'}], 'Projection': {'ProjectionType': 'ALL'}}])
        boto3.client('s3').create_bucket(Bucket='mail-testing', CreateBucketConfiguration={'LocationConstraint': 'eu-west-1'})
        self.table, self.s3, _ = service.clients()
        self.table.put_item(Item={'pk': 'one', 'sk': 'META', 'generation': 'first', 'state': 'Assigned', 'subject': 'owner'})
        for mid, folder in (('m1', 'Inbox'), ('m2', 'Inbox'), ('sent1', 'Sent')):
            self.table.put_item(Item={'pk': 'one#first', 'sk': 'MSG#' + mid, 'id': mid, 'folder': folder, 'seen': False, 'received': '2026-11-02T10:00:0' + str(len(mid)) + 'Z', 'subject': 'Hello', 'sender': 'fan@example.com', 'search': 'hello'})
        self.configure(['read', 'draft'])
        self.ses = MagicMock(); self.ses.send_email.return_value = {'MessageId': 'ses-1'}

    def configure(self, permissions):
        access.owner_dispatch(self.table, self.s3, 'owner', 'POST', '/ai/connections', {'client_id': 'clientA', 'enabled': True, 'mailboxes': {'one': permissions}})

    def box(self, permission='draft'):
        return access.grant(self.table, 'owner', 'clientA', 'one', permission)

    def row(self, mid):
        return self.table.get_item(Key={'pk': 'one#first', 'sk': 'MSG#' + mid})['Item']

    def owner(self, method, path, data=None):
        return service.dispatch(self.table, self.s3, self.ses, 'owner', method, path, data or {}, {})

    def test_owner_can_create_folders_once_and_file_into_them(self):
        self.assertTrue(self.owner('POST', '/mailboxes/one/folders', {'name': ' Promotions '})['created'])
        again = self.owner('POST', '/mailboxes/one/folders', {'name': 'promotions'})
        self.assertFalse(again['created'])
        self.assertEqual(again['folders'].count('Promotions'), 1)
        self.assertIn('Promotions', self.owner('GET', '/mailboxes/one/folders')['folders'])
        self.owner('PATCH', '/mailboxes/one/messages/m1', {'folder': 'Promotions'})
        self.assertEqual(self.row('m1')['folder'], 'Promotions')
        for bad in ('', 'All', 'x' * 101, 'Bad\nname', None):
            with self.assertRaises(ValueError): self.owner('POST', '/mailboxes/one/folders', {'name': bad})

    def test_triage_tags_and_files_but_never_touches_sent_or_trash(self):
        self.owner('POST', '/mailboxes/one/folders', {'name': 'Updates'})
        result = access.organise(self.table, self.box(), 'm1', {'category': 'fyi', 'note': 'A receipt.', 'folder': 'Updates', 'reason': 'Receipt'})
        self.assertEqual((result['folder'], result['triage']['category']), ('Updates', 'fyi'))
        row = self.row('m1')
        self.assertEqual((row['folder'], row['moved_by']['by'], row['moved_by']['from'], row['seen']), ('Updates', 'ai', 'Inbox', False))
        access.organise(self.table, self.box(), 'm2', {'category': 'scam', 'note': 'Fake bank.', 'folder': 'Junk', 'reason': 'Phishing'})
        self.assertEqual(self.row('m2')['folder'], 'Junk')
        for folder in ('Trash', 'Sent', 'Drafts', 'Nowhere'):
            with self.assertRaises(ValueError): access.organise(self.table, self.box(), 'm2', {'folder': folder, 'reason': 'x'})
        with self.assertRaises(service.Denied): access.organise(self.table, self.box(), 'sent1', {'folder': 'Junk', 'reason': 'x'})
        with self.assertRaises(ValueError): access.organise(self.table, self.box(), 'm2', {})

    def test_untriaged_listing_skips_tagged_mail(self):
        access.organise(self.table, self.box(), 'm1', {'category': 'important', 'note': 'A fan wrote.'})
        listed = access.read(self.table, self.s3, self.box('read'), ['messages'], {'folder': 'Inbox', 'untriaged': '1'})
        self.assertEqual([m['id'] for m in listed['messages']], ['m2'])

    def test_read_only_connection_cannot_triage_or_notify(self):
        self.configure(['read'])
        with self.assertRaises(service.Denied): self.box('draft')
        with self.assertRaises(service.Denied): access.notify_owner(self.table, self.ses, 'owner', 'clientA', {'subject': 'Report', 'body': 'Hi'})
        self.ses.send_email.assert_not_called()

    def test_notify_goes_only_to_the_fixed_owner_address_with_a_daily_cap(self):
        result = access.notify_owner(self.table, self.ses, 'owner', 'clientA', {'subject': 'Inbox triage', 'body': 'Two things need you.'})
        self.assertEqual(result['to'], ['adam@extraliferecords.com'])
        sent = self.ses.send_email.call_args.kwargs
        self.assertEqual((sent['FromEmailAddress'], sent['Destination']), ('triage@extraliferecords.com', {'ToAddresses': ['adam@extraliferecords.com']}))
        self.table.put_item(Item={'pk': 'AI#owner', 'sk': 'NOTIFY#' + __import__('time').strftime('%Y-%m-%d', __import__('time').gmtime()), 'sent': access.NOTIFY_DAILY_CAP})
        with self.assertRaises(service.Denied): access.notify_owner(self.table, self.ses, 'owner', 'clientA', {'subject': 'Again', 'body': 'x'})
        with patch.dict(os.environ, NOTIFY_ENABLED='false'):
            with self.assertRaises(service.Denied): access.notify_owner(self.table, self.ses, 'owner', 'clientA', {'subject': 'x', 'body': 'x'})
        with self.assertRaises(service.Denied): access.notify_owner(self.table, self.ses, 'owner', 'clientB', {'subject': 'x', 'body': 'x'})
        self.table.delete_item(Key={'pk': 'AI#owner', 'sk': 'NOTIFY#' + __import__('time').strftime('%Y-%m-%d', __import__('time').gmtime())})
        with self.assertRaises(ValueError): access.notify_owner(self.table, self.ses, 'owner', 'clientA', {'subject': 'Bad\r\nBcc: x', 'body': 'x'})
        self.ses.send_email.assert_called_once()

    def test_mcp_tools_map_to_scopes_and_hide_internal_fields(self):
        listed = remote_mcp.rpc({}, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})['result']['tools']
        names = {tool['name'] for tool in listed}
        self.assertTrue({'mail_triage', 'mail_notify_owner'} <= names)
        self.assertFalse(any('permission' in tool for tool in listed))
        clients = (self.table, self.s3, self.ses)
        read_only = {'sub': 'owner', 'client_id': 'clientA', 'scope': 'https://mail.example/mcp/read'}
        with self.assertRaises(service.Denied):
            remote_mcp.call_tool(*clients, read_only, 'mail_triage', {'mailbox': 'one', 'message_id': 'm1', 'category': 'fyi', 'note': 'x'})
        drafting = {**read_only, 'scope': 'https://mail.example/mcp/read https://mail.example/mcp/draft'}
        remote_mcp.call_tool(*clients, drafting, 'mail_triage', {'mailbox': 'one', 'message_id': 'm1', 'category': 'fyi', 'note': 'A newsletter.', 'target': 'Junk'})
        self.assertEqual(self.row('m1')['folder'], 'Junk')
        boxes = remote_mcp.call_tool(*clients, read_only, 'mailboxes', {})['mailboxes']
        self.assertIn('Junk', boxes[0]['folders'])
        found = remote_mcp.call_tool(*clients, read_only, 'mail_search', {'mailbox': 'one', 'untriaged': True})
        self.assertEqual([m['id'] for m in found['messages']], ['m2'])
        remote_mcp.call_tool(*clients, drafting, 'mail_notify_owner', {'title': 'Inbox triage', 'text': 'Nothing urgent.'})
        self.ses.send_email.assert_called_once()


def sns(source='fan@example.com', spam='PASS', message_id='abc', sender='Fan <fan@example.com>'):
    return {'Sns': {'Message': json.dumps({'mail': {'messageId': message_id, 'source': source, 'commonHeaders': {'from': [sender]}}, 'receipt': {'spamVerdict': {'status': spam}, 'virusVerdict': {'status': 'PASS'}}})}}


class Response:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *exc): return False


@mock_aws
class FireTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, AWS_DEFAULT_REGION='eu-west-1', TABLE='mail', TRIAGE_FIRE_ENABLED='true', TRIAGE_FIRE_SECRET='fire', TRIAGE_DEBOUNCE_SECONDS='300', TRIAGE_IGNORE_SENDERS='triage@extraliferecords.com')
        env.start(); self.addCleanup(env.stop)
        boto3.client('dynamodb').create_table(TableName='mail', BillingMode='PAY_PER_REQUEST', AttributeDefinitions=[{'AttributeName': k, 'AttributeType': 'S'} for k in ('pk', 'sk')], KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}])
        boto3.client('secretsmanager').create_secret(Name='fire', SecretString=json.dumps({'trigger_id': 'trig_123', 'token': 'test-token'}))
        self.opener = MagicMock(return_value=Response())

    def test_new_mail_fires_once_per_window(self):
        self.assertTrue(triage_fire.handler({'Records': [sns()]}, None, self.opener)['fired'])
        request = self.opener.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.anthropic.com/v1/claude_code/routines/trig_123/fire')
        self.assertEqual(request.get_header('Authorization'), 'Bearer test-token')
        self.assertNotIn('fan@example.com', request.data.decode())
        self.assertEqual(triage_fire.handler({'Records': [sns()]}, None, self.opener)['reason'], 'debounced')
        self.opener.assert_called_once()

    def test_spam_own_reports_and_setup_notifications_do_not_fire(self):
        for record in (sns(spam='FAIL'), sns(source='Triage@extraliferecords.com'), sns(source='0102abc@return-mail.extraliferecords.com', sender='Inbox triage <triage@extraliferecords.com>'), sns(message_id='AMAZON_SES_SETUP_NOTIFICATION')):
            self.assertFalse(triage_fire.handler({'Records': [record]}, None, self.opener)['fired'])
        self.opener.assert_not_called()

    def test_failed_fire_releases_the_window_and_never_raises(self):
        self.opener.side_effect = TimeoutError('network')
        self.assertEqual(triage_fire.handler({'Records': [sns()]}, None, self.opener)['reason'], 'failed')
        self.opener.side_effect = None; self.opener.return_value = Response()
        self.assertTrue(triage_fire.handler({'Records': [sns()]}, None, self.opener)['fired'])

    def test_empty_secret_and_disabled_flag_do_nothing(self):
        with patch.dict(os.environ, TRIAGE_FIRE_ENABLED='false'):
            self.assertEqual(triage_fire.handler({'Records': [sns()]}, None, self.opener)['reason'], 'disabled')
        boto3.client('secretsmanager').put_secret_value(SecretId='fire', SecretString=json.dumps({'trigger_id': '', 'token': ''}))
        self.assertEqual(triage_fire.handler({'Records': [sns()]}, None, self.opener)['reason'], 'failed')
        self.opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
