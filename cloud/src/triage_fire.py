"""Wake the owner's Claude triage routine when new mail arrives.

Subscribed to the same SNS topic as the receiver. It never reads or forwards
mail: the routine fetches untriaged mail itself through the Envelope connector.
At most one fire per debounce window, so a burst of mail starts one run and the
routine's hourly schedule picks up anything that arrives mid-run.
"""
import json
import os
import time
import urllib.request
from email.utils import parseaddr

import boto3
from botocore.exceptions import ClientError

FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/{}/fire'
PROMPT = 'New mail has arrived. Triage the untriaged mail now.'


def wanted(notification):
    mail, receipt = notification.get('mail', {}), notification.get('receipt', {})
    if mail.get('messageId') == 'AMAZON_SES_SETUP_NOTIFICATION': return False
    # Spam and viruses land in Junk on their own; they don't need a run.
    if any(receipt.get(kind, {}).get('status') != 'PASS' for kind in ('spamVerdict', 'virusVerdict')): return False
    ignored = {address.strip().lower() for address in os.environ.get('TRIAGE_IGNORE_SENDERS', '').split(',') if address.strip()}
    # The routine's own report must not wake the routine again. SES rewrites the envelope
    # sender to the custom MAIL FROM domain, so check the From header too.
    senders = [mail.get('source') or ''] + [parseaddr(value)[1] for value in mail.get('commonHeaders', {}).get('from', [])]
    return not any(sender.lower() in ignored for sender in senders)


def claim(table, now, debounce):
    try:
        table.update_item(Key={'pk': 'TRIAGE', 'sk': 'FIRE'}, UpdateExpression='SET last_fired=:now',
                          ConditionExpression='attribute_not_exists(last_fired) OR last_fired <= :cutoff',
                          ExpressionAttributeValues={':now': now, ':cutoff': now - debounce})
        return True
    except ClientError as exc:
        if exc.response['Error']['Code'] != 'ConditionalCheckFailedException': raise
        return False


def release(table, now):
    # A failed fire must not block the next email from trying again.
    try:
        table.update_item(Key={'pk': 'TRIAGE', 'sk': 'FIRE'}, UpdateExpression='REMOVE last_fired',
                          ConditionExpression='last_fired = :now', ExpressionAttributeValues={':now': now})
    except ClientError:
        pass


def fire(secret, opener=urllib.request.urlopen):
    request = urllib.request.Request(FIRE_URL.format(secret['trigger_id']), method='POST',
                                     data=json.dumps({'text': PROMPT}).encode(),
                                     headers={'Authorization': 'Bearer ' + secret['token'], 'Content-Type': 'application/json',
                                              'anthropic-version': '2026-10-21', 'anthropic-beta': 'experimental-cc-routine-2026-04-01'})
    with opener(request, timeout=10) as response:
        return response.status


def handler(event, context, opener=urllib.request.urlopen):
    if os.environ.get('TRIAGE_FIRE_ENABLED') != 'true': return {'fired': False, 'reason': 'disabled'}
    if not any(wanted(json.loads(record['Sns']['Message'])) for record in event.get('Records', [])):
        return {'fired': False, 'reason': 'nothing to triage'}
    table = boto3.resource('dynamodb').Table(os.environ['TABLE'])
    now = int(time.time())
    if not claim(table, now, int(os.environ.get('TRIAGE_DEBOUNCE_SECONDS', '300'))):
        return {'fired': False, 'reason': 'debounced'}
    try:
        secret = json.loads(boto3.client('secretsmanager').get_secret_value(SecretId=os.environ['TRIAGE_FIRE_SECRET'])['SecretString'])
        if not secret.get('trigger_id') or not secret.get('token'): raise ValueError('Triage fire secret is not filled in')
        status = fire(secret, opener)
    except Exception as exc:
        release(table, now)
        # Never raise: an SNS retry would only repeat the same fire. The hourly schedule is the backstop.
        print(json.dumps({'triage_fire': 'failed', 'error': type(exc).__name__, 'status': getattr(exc, 'code', None)}))
        return {'fired': False, 'reason': 'failed'}
    print(json.dumps({'triage_fire': 'fired', 'status': status}))
    return {'fired': True, 'status': status}
