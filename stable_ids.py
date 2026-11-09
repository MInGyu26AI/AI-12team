"""Stable ids for intake messages, batches, cards and quarantined input."""
import hashlib
import json


def digest(value):
    """sha256 of JSON-serialisable parts, independent of key order."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
