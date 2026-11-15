"""Immutable attachment bytes scoped to a mailbox; drafts reference opaque IDs."""
import base64
import mimetypes
import os
import re
import uuid
import hashlib
from pathlib import Path
from agent_store import AgentStore

MAX_FILE = 10 * 1024 * 1024
MAX_TOTAL = 20 * 1024 * 1024

_UNSAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def downloads_dir():
    return Path.home() / "Downloads" / "Envelope"


def safe_filename(name, fallback="attachment"):
    """A plain file name that cannot leave the folder it is written to."""
    base = str(name or "").replace("\\", "/").split("/")[-1]
    base = _UNSAFE_NAME.sub("_", base).strip(" .")
    if not base:
        base = fallback
    if base.split(".")[0].upper() in _RESERVED_NAMES:
        base = "_" + base
    stem, ext = os.path.splitext(base)
    if len(ext) > 20:
        stem, ext = base, ""
    return stem[:150 - len(ext)] + ext


def save_download(name, payload, fallback="attachment", folder=None):
    """Write an attachment into Downloads\\Envelope without asking anyone.

    Never shows a Save As box: the AI tools call this, and nobody may be at the PC.
    An existing file is never overwritten; the new one becomes "name (2).ext"."""
    folder = Path(folder) if folder else downloads_dir()
    folder.mkdir(parents=True, exist_ok=True)
    base = safe_filename(name, fallback)
    stem, ext = os.path.splitext(base)
    for n in range(1, 1000):
        target = folder / (base if n == 1 else f"{stem} ({n}){ext}")
        if target.resolve().parent != folder.resolve():
            raise ValueError("Invalid attachment filename")
        try:
            with open(target, "xb") as fh:
                fh.write(payload)
            return str(target)
        except FileExistsError:
            continue
    raise ValueError("Too many files with this name in Downloads\\Envelope")


class AttachmentStore(AgentStore):
    def __init__(self, path):
        super().__init__(path)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS attachments "
                       "(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,name TEXT NOT NULL,"
                       "content_type TEXT NOT NULL,data BLOB NOT NULL)")

    def add(self, account_id, name, data):
        if not isinstance(name, str) or not name or len(name) > 255 or any(c in name for c in '\r\n\x00/\\'):
            raise ValueError("Invalid attachment filename")
        if not isinstance(data, bytes) or len(data) > MAX_FILE:
            raise ValueError("Each attachment must be at most 10 MB")
        digest = hashlib.sha256(data).hexdigest()
        attachment_id = str(uuid.uuid5(uuid.NAMESPACE_URL, account_id + ':' + name + ':' + digest))
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        with self.connect() as db:
            db.execute("INSERT OR IGNORE INTO attachments VALUES(?,?,?,?,?)", (attachment_id, account_id, name, content_type, data))
        return {"id": attachment_id, "name": name, "content_type": content_type, "size": len(data)}

    def add_base64(self, account_id, name, encoded):
        if not isinstance(encoded, str) or len(encoded) > ((MAX_FILE + 2) // 3) * 4:
            raise ValueError("Each attachment must be at most 10 MB")
        try:
            data = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError):
            raise ValueError("Invalid attachment content") from None
        return self.add(account_id, name, data)

    def resolve(self, account_id, ids):
        if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids) or len(ids) > 20 or len(set(ids)) != len(ids):
            raise ValueError("Select up to 20 distinct attachments")
        items = []
        with self.connect() as db:
            for attachment_id in ids:
                if not isinstance(attachment_id, str):
                    raise ValueError("Invalid attachment ID")
                row = db.execute("SELECT * FROM attachments WHERE id=? AND account_id=?",
                                 (attachment_id, account_id)).fetchone()
                if row is None:
                    raise ValueError("Attachment is unavailable in this mailbox")
                items.append(dict(row))
        if sum(len(item["data"]) for item in items) > MAX_TOTAL:
            raise ValueError("Attachments together must be at most 20 MB")
        return items


def reply_context(msg, own_addresses, reply_all=False):
    """Use Reply-To, deduplicate case-insensitively and exclude mailbox identities."""
    from email.utils import getaddresses, formataddr
    own = {address.lower() for address in own_addresses if address}
    seen = set(own)
    def unique(values):
        result = []
        for label, address in getaddresses(values):
            if address and '@' in address and address.lower() not in seen:
                seen.add(address.lower())
                result.append(formataddr((label, address)))
        return ', '.join(result)
    to = unique([str(msg.get("Reply-To") or msg.get("From", ""))])
    # Messages sent by this mailbox reply to the original recipients.
    if not to:
        to = unique([str(msg.get("To", ""))])
    cc = unique([str(msg.get("To", "")), str(msg.get("Cc", ""))]) if reply_all else ""
    message_id = str(msg.get("Message-ID", ""))
    references = (str(msg.get("References", "")) + " " + message_id).strip()
    return {"to": to, "cc": cc, "in_reply_to": message_id, "references": references}
